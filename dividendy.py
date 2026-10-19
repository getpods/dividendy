###
#python3 dividendy.py  \
#  --degiro degiro_2025.csv \
#  --ibkr ibkr_2025.csv \
#  --outdir 2025
###

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
from collections import Counter
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import Iterable

import pandas as pd


# =========================
# Helpers
# =========================

def parse_cz_number(value: str) -> Decimal:
    """
    Převod čísel jako:
    3,68 -> 3.68
    -0,55 -> -0.55
    0.77 -> 0.77
    """
    if value is None:
        raise ValueError("Chybí částka")
    if not isinstance(value, str) and pd.isna(value):
        raise ValueError("Chybí částka")
    s = str(value).strip().replace("\xa0", "").replace(" ", "")
    if s == "":
        raise ValueError("Chybí částka")

    # pokud je tam čárka i tečka, zkusíme rozpoznat formát
    if "," in s and "." in s:
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s:
        s = s.replace(",", ".")

    try:
        parsed = Decimal(s)
    except InvalidOperation as exc:
        raise ValueError(f"Neplatná částka: {value!r}") from exc
    if not parsed.is_finite():
        raise ValueError(f"Neplatná částka: {value!r}")
    return parsed


def normalize_date(series: pd.Series, dayfirst: bool = False) -> pd.Series:
    parsed = pd.to_datetime(series, errors="coerce", dayfirst=dayfirst)
    invalid = parsed.isna()
    if invalid.any():
        examples = series[invalid].astype(str).head(5).tolist()
        raise ValueError(f"Neplatné nebo chybějící datum: {examples}")
    return parsed.dt.date


def _parse_one_date(value: str, dayfirst: bool) -> object:
    parsed = pd.to_datetime(value, errors="coerce", dayfirst=dayfirst)
    if pd.isna(parsed):
        raise ValueError(f"Neplatné nebo chybějící datum: {value!r}")
    return parsed.date()


def exact_decimal_sum(values) -> Decimal:
    """Add finite Decimals without the default context rounding large totals."""
    values = list(values)
    if not values:
        return Decimal("0")
    if any(not isinstance(value, Decimal) or not value.is_finite() for value in values):
        raise TypeError("exact_decimal_sum accepts only finite Decimal values")
    min_exponent = min(value.as_tuple().exponent for value in values)
    max_adjusted = max((value.adjusted() for value in values if value), default=0)
    required_precision = max(1, max_adjusted - min_exponent + len(str(len(values))) + 2)
    with localcontext() as context:
        context.prec = max(context.prec, required_precision)
        return sum(values, Decimal("0"))


def _source_file_name(source_file) -> str:
    if isinstance(source_file, (str, Path)):
        return str(source_file)
    return str(getattr(source_file, "name", source_file))


def _open_csv_text(source_file):
    """Return a fresh text stream for a path or an in-memory CSV stream."""
    if hasattr(source_file, "getvalue"):
        return io.StringIO(source_file.getvalue())
    return open(source_file, "r", encoding="utf-8-sig", newline="")


def _source_record(source_file, source_row, raw_date, raw_currency, raw_amount, raw_description):
    return {
        "source_file": _source_file_name(source_file),
        "source_row": int(source_row),
        "raw_date": str(raw_date),
        "raw_currency": str(raw_currency),
        "raw_amount": str(raw_amount),
        "raw_description": str(raw_description),
    }


def _encode_records(records) -> str:
    return json.dumps(records, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _add_diagnostic(diagnostics, source_file, source_row, issue_type, message, **raw):
    diagnostics.append({
        "source_file": _source_file_name(source_file),
        "source_row": int(source_row) if source_row not in (None, "") else "",
        "issue_type": issue_type,
        "message": message,
        **raw,
    })


DETAIL_COLUMNS = [
    "broker", "date", "symbol_or_product", "isin", "currency",
    "gross_dividend", "withholding_tax", "withholding_tax_signed",
    "tax_adjustment_amount", "tax_sign_status", "net_dividend", "source_file",
    "source_rows", "source_records", "review_status",
]

DIAGNOSTIC_COLUMNS = [
    "source_file", "source_row", "issue_type", "message", "raw_date",
    "raw_currency", "raw_amount", "raw_description",
]


# =========================
# DEGIRO
# =========================

def parse_degiro(csv_path: str | Path) -> pd.DataFrame:
    """
    DEGIRO export ve stylu:

    Datum | Čas | Datum.1 | Produkt | ISIN | Popis | Kurz | Pohyb | Unnamed: 8 | Zůstatek | Unnamed: 10 | ID objednávky

    Kde typicky:
    - Pohyb = měna pohybu
    - sloupec hned za Pohyb = částka pohybu
    """

    csv_path = csv_path if hasattr(csv_path, "read") else Path(csv_path)
    df = pd.read_csv(
        csv_path, sep=None, engine="python", dtype=str, keep_default_na=False,
    )
    df.columns = [str(c).strip() for c in df.columns]

    # pandas renames repeated CSV headers (e.g. the second "Datum" to
    # "Datum.1"). Keep both values in provenance. Public broker docs do not
    # define the meaning of the two fields, so never treat them as aliases.
    date_columns = [c for c in df.columns if c == "Datum" or c.startswith("Datum.")]

    def find_first(candidates: list[str]) -> str | None:
        for c in candidates:
            if c in df.columns:
                return c
        return None

    date_col = find_first(["Datum", "Date"])
    product_col = find_first(["Produkt", "Product"])
    isin_col = find_first(["ISIN"])
    desc_col = find_first(["Popis", "Description"])
    movement_currency_col = find_first(["Pohyb", "Amount", "Movement"])

    if not date_col or not product_col or not desc_col or not movement_currency_col:
        raise ValueError(
            f"DEGIRO: nepodařilo se najít potřebné sloupce. Sloupce: {list(df.columns)}"
        )

    movement_currency_idx = df.columns.get_loc(movement_currency_col)

    # Částka bývá hned v dalším sloupci za Pohyb
    if movement_currency_idx + 1 >= len(df.columns):
        raise ValueError(
            f"DEGIRO: za sloupcem {movement_currency_col} není sloupec s částkou."
        )

    movement_amount_col = df.columns[movement_currency_idx + 1]

    valid_rows = []
    diagnostics = []
    group_fields = ["date", "symbol_or_product", "isin", "currency"]

    for index, row in df.iterrows():
        source_row = int(index) + 2
        raw_date = row[date_col]
        secondary_dates = [str(row[c]) for c in date_columns if c != date_col]
        raw_product = row[product_col]
        raw_isin = row[isin_col] if isin_col else ""
        raw_description = row[desc_col]
        raw_currency = row[movement_currency_col]
        raw_amount = row[movement_amount_col]
        description = str(raw_description).strip()
        desc_lower = description.lower()

        is_tax = (
            desc_lower in ["daň z dividendy", "dan z dividendy"]
            or "dividend tax" in desc_lower
        )
        is_dividend = "dividenda" in desc_lower or ("dividend" in desc_lower and not is_tax)

        source = _source_record(
            csv_path, source_row, raw_date, raw_currency, raw_amount, raw_description,
        )
        source["raw_additional_dates"] = secondary_dates
        if not is_tax and not is_dividend:
            _add_diagnostic(
                diagnostics, csv_path, source_row, "unrecognized_record",
                "Záznam není rozpoznán jako dividenda ani srážková daň.",
                raw_date=raw_date, raw_currency=raw_currency,
                raw_amount=raw_amount, raw_description=raw_description,
            )
            continue

        try:
            date = _parse_one_date(raw_date, dayfirst=True)
            parsed_secondary_dates = []
            for secondary_date in secondary_dates:
                if secondary_date.strip():
                    parsed_secondary_dates.append(
                        _parse_one_date(secondary_date, dayfirst=True)
                    )
            amount = parse_cz_number(raw_amount)
            currency = str(raw_currency).strip()
            if not currency:
                raise ValueError("Chybí měna pohybu")
        except ValueError as exc:
            _add_diagnostic(
                diagnostics, csv_path, source_row, "invalid_record", str(exc),
                raw_date=raw_date, raw_currency=raw_currency,
                raw_amount=raw_amount, raw_description=raw_description,
            )
            continue

        valid_rows.append({
            **source,
            "date": date,
            "symbol_or_product": str(raw_product).strip(),
            "isin": str(raw_isin).strip(),
            "description": description,
            "currency": currency,
            "amount": amount,
            "kind": "tax" if is_tax else "dividend",
            "date_fields_disagree": any(value != date for value in parsed_secondary_dates),
            # Do not match a tax against a dividend when the export's two date
            # columns conflict; their meaning is not documented.
            "date_pair_key": ("tax" if is_tax else "dividend")
            if any(value != date for value in parsed_secondary_dates) else "",
        })
        if valid_rows[-1]["date_fields_disagree"]:
            _add_diagnostic(
                diagnostics, csv_path, source_row, "ambiguous_date_fields",
                "Datumové sloupce DEGIRO se liší; pro kompatibilitu se použilo první Datum, význam polí není ověřen.",
                raw_date=raw_date, raw_currency=raw_currency,
                raw_amount=raw_amount, raw_description=raw_description,
            )

    work = pd.DataFrame(valid_rows)
    output_rows = []
    duplicate_source_rows = set()
    occurrences = Counter(
        (
            row["date"], row["symbol_or_product"], row["isin"],
            row["currency"], row["kind"], row["amount"], row["description"],
        )
        for row in valid_rows
    )
    for signature, count in occurrences.items():
        if count > 1:
            duplicate_rows = [
                row for row in valid_rows
                if (
                    row["date"], row["symbol_or_product"], row["isin"],
                    row["currency"], row["kind"], row["amount"], row["description"],
                ) == signature
            ]
            duplicate_source_rows.update(row["source_row"] for row in duplicate_rows)
            _add_diagnostic(
                diagnostics, csv_path, duplicate_rows[0]["source_row"],
                "suspected_duplicate_transaction",
                f"{count} shodných řádků může představovat duplicitu; všechny zůstaly zachovány.",
                raw_date=duplicate_rows[0]["raw_date"],
                raw_currency=duplicate_rows[0]["raw_currency"],
                raw_amount=duplicate_rows[0]["raw_amount"],
                raw_description=duplicate_rows[0]["raw_description"],
            )
    if not work.empty:
        grouped = work.groupby(group_fields + ["kind", "date_pair_key"], sort=False, dropna=False)
        aggregates = []
        for keys, group in grouped:
            row_data = dict(zip(group_fields + ["kind", "date_pair_key"], keys))
            row_data["amount"] = exact_decimal_sum(group["amount"])
            row_data["source_records"] = _encode_records(group[[
                "source_file", "source_row", "raw_date", "raw_currency",
                "raw_amount", "raw_description",
            ]].to_dict("records"))
            if "raw_additional_dates" in group.columns:
                decoded = json.loads(row_data["source_records"])
                for record, (_, original) in zip(decoded, group.iterrows()):
                    record["raw_additional_dates"] = original["raw_additional_dates"]
                row_data["source_records"] = _encode_records(decoded)
            row_data["source_rows"] = ",".join(str(n) for n in group["source_row"])
            aggregates.append(row_data)
        aggregated = pd.DataFrame(aggregates)
        dividends = aggregated[aggregated["kind"] == "dividend"].drop(columns="kind")
        taxes = aggregated[aggregated["kind"] == "tax"].drop(columns="kind")
        join_fields = group_fields + ["date_pair_key"]
        merged = pd.merge(dividends, taxes, on=join_fields, how="outer", suffixes=("_gross", "_tax"))
        for _, row in merged.iterrows():
            gross = row.get("amount_gross")
            tax = row.get("amount_tax")
            gross = gross if isinstance(gross, Decimal) else Decimal("0")
            tax = tax if isinstance(tax, Decimal) else Decimal("0")
            source_records = []
            dividend_records = []
            source_rows = []
            for key in ("source_records_gross", "source_records_tax"):
                value = row.get(key)
                if isinstance(value, str) and value:
                    decoded = json.loads(value)
                    source_records.extend(decoded)
                    if key == "source_records_gross":
                        dividend_records.extend(decoded)
            for key in ("source_rows_gross", "source_rows_tax"):
                value = row.get(key)
                if isinstance(value, str) and value:
                    source_rows.extend(value.split(","))
            statuses = []
            group_rows = [item for item in valid_rows if (
                item["date"] == row["date"]
                and item["symbol_or_product"] == row["symbol_or_product"]
                and item["isin"] == row["isin"]
                and item["currency"] == row["currency"]
            )]
            if any(item["date_fields_disagree"] for item in group_rows):
                statuses.append("ambiguous_date_fields")
            if not dividend_records and tax != 0:
                statuses.append("unmatched_tax")
            if tax != 0 and dividend_records and gross == 0:
                statuses.append("tax_with_zero_gross")
            if any(int(record["source_row"]) in duplicate_source_rows for record in source_records):
                statuses.append("suspected_duplicate_transaction")
            output_rows.append({
                "broker": "DEGIRO", "date": row["date"],
                "symbol_or_product": row["symbol_or_product"], "isin": row["isin"],
                "currency": row["currency"], "gross_dividend": gross,
                "withholding_tax": abs(tax),
                "withholding_tax_signed": tax,
                "tax_adjustment_amount": Decimal("0"),
                "tax_sign_status": "",
                "net_dividend": exact_decimal_sum([gross, -abs(tax)]),
                "source_file": _source_file_name(csv_path), "source_rows": ",".join(source_rows),
                "source_records": _encode_records(source_records),
                "review_status": ";".join(statuses),
            })

    result = pd.DataFrame(output_rows, columns=DETAIL_COLUMNS)
    result = result.sort_values(["date", "symbol_or_product"]).reset_index(drop=True) if not result.empty else result
    result.attrs["diagnostics"] = diagnostics
    result.attrs["warnings"] = [item["message"] for item in diagnostics]
    return result


# =========================
# IBKR
# =========================

def _extract_ibkr_section_rows(csv_path: str | Path, section_name: str) -> list[tuple[int, list[str]]]:
    """
    Najde všechny řádky začínající na např.
    'Dividends,Header,...'
    'Dividends,Data,...'
    nebo
    'Withholding Tax,Header,...'
    'Withholding Tax,Data,...'

    Vrací seznam řádků jako pole hodnot.
    """
    rows: list[tuple[int, list[str]]] = []

    with _open_csv_text(csv_path) as f:
        reader = csv.reader(f)
        previous_line_number = 0
        for row in reader:
            line_number = previous_line_number + 1
            previous_line_number = reader.line_num
            if not row:
                continue
            if row[0].strip() == section_name:
                rows.append((line_number, row))

    return rows


def _diagnose_unsupported_ibkr_dividend_sections(
    csv_path: str | Path,
    diagnostics: list[dict],
) -> None:
    """Keep dividend accrual records visible without treating them as cash payments."""
    unsupported_sections = {"Change in Dividend Accruals"}
    with _open_csv_text(csv_path) as f:
        reader = csv.reader(f)
        previous_line_number = 0
        for row in reader:
            line_number = previous_line_number + 1
            previous_line_number = reader.line_num
            if len(row) > 1 and row[0].strip() in unsupported_sections and row[1].strip() == "Data":
                section = row[0].strip()
                _add_diagnostic(
                    diagnostics,
                    csv_path,
                    line_number,
                    "unsupported_section",
                    f"IBKR sekce {section!r} obsahuje dividendové accrual záznamy mimo podporovaný import hotovostních dividend; řádek nebyl započítán.",
                    raw_date="", raw_currency="", raw_amount="", raw_description="",
                )


def _ibkr_section_to_df(
    rows: list[tuple[int, list[str]]],
    csv_path: str | Path,
    diagnostics: list[dict],
) -> pd.DataFrame:
    """
    Z řádků IBKR sekce vytvoří DataFrame.
    Očekává aspoň jeden Header řádek a Data řádky.
    """
    header = None
    records = []
    source_rows = []

    for line_number, row in rows:
        if len(row) < 2:
            continue
        record_type = row[1].strip()

        if record_type == "Header":
            header = row[2:]
        elif record_type == "Data":
            if header is None:
                _add_diagnostic(
                    diagnostics, csv_path, line_number, "malformed_record",
                    "Datový řádek IBKR se objevil bez předchozí hlavičky.",
                    raw_date="", raw_currency="", raw_amount="",
                    raw_description=",".join(row[2:]),
                )
                continue
            values = row[2:]
            if len(values) != len(header):
                _add_diagnostic(
                    diagnostics, csv_path, line_number, "malformed_record",
                    f"Počet polí IBKR řádku ({len(values)}) neodpovídá hlavičce ({len(header)}).",
                    raw_date="", raw_currency="", raw_amount="",
                    raw_description=",".join(values),
                )
                continue
            records.append(dict(zip(header, values)))
            source_rows.append(line_number)

    if header is None:
        return pd.DataFrame()
    result = pd.DataFrame(records)
    result.insert(0, "source_row", source_rows)
    return result


def parse_ibkr(csv_path: str | Path) -> pd.DataFrame:
    """
    Zpracuje IBKR CSV, kde se střídají sekce s různými hlavičkami.
    Bere jen dividendy a withholding tax vztahující se k dividendám.
    Ignoruje např.:
    - Withholding @ 20% on Credit Interest ...
    """
    csv_path = csv_path if hasattr(csv_path, "read") else Path(csv_path)
    diagnostics = []
    _diagnose_unsupported_ibkr_dividend_sections(csv_path, diagnostics)
    div_rows = _extract_ibkr_section_rows(csv_path, "Dividends")
    tax_rows = _extract_ibkr_section_rows(csv_path, "Withholding Tax")

    for line_number, row in div_rows + tax_rows:
        if len(row) > 1 and row[1].strip() not in {"Header", "Data"}:
            _add_diagnostic(
                diagnostics, csv_path, line_number, "unknown_record_type",
                f"Neznámý typ IBKR záznamu: {row[1].strip()!r}",
                raw_date="", raw_currency="", raw_amount="",
                raw_description=",".join(row[2:]),
            )

    div_df = _ibkr_section_to_df(div_rows, csv_path, diagnostics)
    tax_df = _ibkr_section_to_df(tax_rows, csv_path, diagnostics)

    if div_df.empty and tax_df.empty:
        if diagnostics:
            result = pd.DataFrame(columns=DETAIL_COLUMNS)
            result.attrs["diagnostics"] = diagnostics
            result.attrs["warnings"] = [item["message"] for item in diagnostics]
            return result
        raise ValueError(
            "IBKR: nenašel jsem sekce Dividends ani Withholding Tax. "
            "Zkontroluj export."
        )

    def prep(df: pd.DataFrame, kind: str) -> pd.DataFrame:
        if df.empty:
            return pd.DataFrame(columns=[
                "date", "currency", "description", "amount", "kind",
                "isin", "symbol_or_product", "source_row", "source_file",
                "raw_date", "raw_currency", "raw_amount", "raw_description",
            ])

        required = ["Currency", "Date", "Description", "Amount"]
        for col in required:
            if col not in df.columns:
                raise ValueError(
                    f"IBKR {kind}: chybí sloupec {col}. Sloupce: {list(df.columns)}"
                )

        valid = []
        for _, row in df.iterrows():
            source_row = int(row["source_row"])
            raw_date = row["Date"]
            raw_currency = row["Currency"]
            raw_amount = row["Amount"]
            raw_description = row["Description"]
            description = str(raw_description).strip()
            try:
                date = _parse_one_date(raw_date, dayfirst=False)
                amount = parse_cz_number(raw_amount)
                currency = str(raw_currency).strip()
                if not currency:
                    raise ValueError("Chybí měna")
            except ValueError as exc:
                _add_diagnostic(
                    diagnostics, csv_path, source_row, "invalid_record", str(exc),
                    raw_date=raw_date, raw_currency=raw_currency,
                    raw_amount=raw_amount, raw_description=raw_description,
                )
                continue

            isin = ""
            matched_isin = pd.Series([description]).str.extract(
                r"\(([A-Z0-9]{12})\)", expand=False
            ).iloc[0]
            if pd.notna(matched_isin):
                isin = matched_isin
            valid.append({
                **_source_record(
                    csv_path, source_row, raw_date, raw_currency,
                    raw_amount, raw_description,
                ),
                "date": date,
                "currency": currency,
                "description": description,
                "amount": amount,
                "kind": kind,
                "isin": isin,
                "symbol_or_product": description,
            })
        return pd.DataFrame(valid, columns=[
            "date", "currency", "description", "amount", "kind", "isin",
            "symbol_or_product", "source_row", "source_file", "raw_date",
            "raw_currency", "raw_amount", "raw_description",
        ])

    div_work = prep(div_df, "dividend")
    tax_work = prep(tax_df, "tax")

    # --- jen skutečné dividendy ---
    div_desc = div_work["description"].str.lower()

    div_is_dividend = (
        div_desc.str.contains("dividend", na=False)
        | div_desc.str.contains("payment in lieu of dividend", na=False)
    )

    for _, row in div_work[~div_is_dividend].iterrows():
        _add_diagnostic(
            diagnostics, csv_path, row["source_row"], "unrecognized_record",
            "Záznam sekce Dividends nebyl rozpoznán jako dividenda.",
            raw_date=row["raw_date"], raw_currency=row["raw_currency"],
            raw_amount=row["raw_amount"], raw_description=row["raw_description"],
        )
    div_work = div_work[div_is_dividend].copy()

    # --- jen withholding tax vztahující se k dividendám ---
    tax_desc = tax_work["description"].str.lower()

    tax_is_dividend_related = (
        tax_desc.str.contains("dividend", na=False)
        | tax_desc.str.contains("payment in lieu of dividend", na=False)
    )

    # explicitně ignorujeme credit interest withholding
    tax_is_credit_interest = (
        tax_desc.str.contains("credit interest", na=False)
        | tax_desc.str.contains("withholding @", na=False) & tax_desc.str.contains("interest", na=False)
    )

    ignored_tax = tax_work[~(tax_is_dividend_related & ~tax_is_credit_interest)]
    for _, row in ignored_tax.iterrows():
        _add_diagnostic(
            diagnostics, csv_path, row["source_row"], "unrecognized_record",
            "Daňový záznam nesouvisí s dividendou podle rozpoznaného popisu.",
            raw_date=row["raw_date"], raw_currency=row["raw_currency"],
            raw_amount=row["raw_amount"], raw_description=row["raw_description"],
        )
    tax_work = tax_work[tax_is_dividend_related & ~tax_is_credit_interest].copy()

    # Keep the source sign. The report format does not identify whether a
    # positive tax entry is a refund, correction, or another adjustment.
    if not tax_work.empty:
        tax_work["tax_sign_status"] = tax_work["amount"].map(
            lambda amount: "debit_candidate" if amount < 0 else (
                "zero_neutral" if amount == 0 else "positive_adjustment_unverified"
            )
        )
        for _, row in tax_work[tax_work["amount"].map(lambda amount: amount > 0)].iterrows():
            _add_diagnostic(
                diagnostics, csv_path, row["source_row"], "tax_sign_requires_review",
                "Kladná částka v sekci Withholding Tax může být vratka, oprava nebo jiný pohyb; nebyla započtena ani spárována.",
                raw_date=row["raw_date"], raw_currency=row["raw_currency"],
                raw_amount=row["raw_amount"], raw_description=row["raw_description"],
            )

    duplicate_source_rows = set()
    for frame, kind in ((div_work, "dividend"), (tax_work, "tax")):
        occurrences = Counter(
            (row["date"], row["isin"], row["currency"], row["amount"], row["description"])
            for _, row in frame.iterrows()
        )
        for signature, count in occurrences.items():
            if count > 1:
                duplicates = frame[
                    frame.apply(
                        lambda row: (
                            row["date"], row["isin"], row["currency"],
                            row["amount"], row["description"],
                        ) == signature,
                        axis=1,
                    )
                ]
                duplicate_source_rows.update(int(n) for n in duplicates["source_row"])
                first = duplicates.iloc[0]
                _add_diagnostic(
                    diagnostics, csv_path, first["source_row"],
                    "suspected_duplicate_transaction",
                    f"{count} shodných IBKR {kind} řádků může představovat duplicitu; všechny zůstaly zachovány.",
                    raw_date=first["raw_date"], raw_currency=first["raw_currency"],
                    raw_amount=first["raw_amount"], raw_description=first["raw_description"],
                )

    # With a missing ISIN, keep descriptions separate so one tax row cannot
    # silently be applied to several instruments sharing the empty ISIN key.
    div_work["_unknown_isin_symbol"] = div_work["symbol_or_product"].where(
        div_work["isin"].eq(""), ""
    )
    group_fields = ["date", "isin", "currency", "_unknown_isin_symbol"]
    div_aggregates = []
    if not div_work.empty:
        for keys, group in div_work.groupby(group_fields, sort=False, dropna=False):
            date, isin, currency, _ = keys
            records = group[[
                "source_file", "source_row", "raw_date", "raw_currency",
                "raw_amount", "raw_description",
            ]].to_dict("records")
            for record, (_, original) in zip(records, group.iterrows()):
                record["raw_additional_dates"] = original.get("raw_additional_dates", [])
            div_aggregates.append({
                "date": date, "isin": isin, "currency": currency,
                "gross_dividend": exact_decimal_sum(group["amount"]),
                "symbol_or_product": group.iloc[0]["symbol_or_product"],
                "source_rows": ",".join(str(n) for n in group["source_row"]),
                "source_records": _encode_records(records),
            })
    div_agg = pd.DataFrame(div_aggregates, columns=[
        "date", "isin", "currency", "gross_dividend", "symbol_or_product",
        "source_rows", "source_records",
    ])

    tax_aggregates = []
    if not tax_work.empty:
        for keys, group in tax_work.groupby(
            ["date", "isin", "currency", "tax_sign_status"], sort=False, dropna=False
        ):
            date, isin, currency, tax_sign_status = keys
            records = group[[
                "source_file", "source_row", "raw_date", "raw_currency",
                "raw_amount", "raw_description",
            ]].to_dict("records")
            tax_aggregates.append({
                "date": date, "isin": isin, "currency": currency,
                "withholding_tax": exact_decimal_sum(group["amount"]),
                "tax_sign_status": tax_sign_status,
                "tax_description": group.iloc[0]["description"],
                "tax_source_rows": ",".join(str(n) for n in group["source_row"]),
                "tax_source_records": _encode_records(records),
            })
    tax_agg = pd.DataFrame(tax_aggregates, columns=[
        "date", "isin", "currency", "withholding_tax", "tax_sign_status", "tax_description",
        "tax_source_rows", "tax_source_records",
    ])

    # Only a non-empty ISIN can establish the current parser's tax match.
    known_dividends = div_agg[div_agg["isin"].ne("")]
    missing_isin_dividends = div_agg[div_agg["isin"].eq("")]
    positive_taxes = tax_agg[tax_agg["tax_sign_status"].eq("positive_adjustment_unverified")]
    debit_taxes = tax_agg[tax_agg["tax_sign_status"].isin(["debit_candidate", "zero_neutral"])]
    known_taxes = debit_taxes[debit_taxes["isin"].ne("")]
    missing_isin_taxes = debit_taxes[debit_taxes["isin"].eq("")]

    out_rows = []
    known = pd.merge(known_dividends, known_taxes, on=["date", "isin", "currency"], how="outer")
    for _, row in known.iterrows():
        gross = row.get("gross_dividend")
        tax = row.get("withholding_tax")
        gross = gross if isinstance(gross, Decimal) else Decimal("0")
        tax = tax if isinstance(tax, Decimal) else Decimal("0")
        records = []
        dividend_records = []
        for key in ("source_records", "tax_source_records"):
            value = row.get(key)
            if isinstance(value, str) and value:
                decoded = json.loads(value)
                records.extend(decoded)
                if key == "source_records":
                    dividend_records.extend(decoded)
        is_unmatched_tax = tax != 0 and not dividend_records
        line_refs = []
        for key in ("source_rows", "tax_source_rows"):
            value = row.get(key)
            if isinstance(value, str) and value:
                line_refs.extend(value.split(","))
        if any(
            int(record["source_row"]) in duplicate_source_rows
            for record in records
        ):
            review_status = "suspected_duplicate_transaction"
        else:
            review_status = ""
        if is_unmatched_tax:
            review_status = ";".join(
                part for part in (review_status, "unmatched_tax") if part
            )
        if tax != 0 and dividend_records and gross == 0:
            review_status = ";".join(
                part for part in (review_status, "tax_with_zero_gross") if part
            )
        symbol = row.get("symbol_or_product")
        if not isinstance(symbol, str) or not symbol:
            symbol = row.get("tax_description", "")
        out_rows.append({
            "date": row["date"], "isin": row["isin"], "currency": row["currency"],
            "gross_dividend": gross, "withholding_tax": -tax,
            "withholding_tax_signed": tax,
            "tax_adjustment_amount": Decimal("0"),
            "tax_sign_status": "debit_candidate" if tax < 0 else "",
            "symbol_or_product": symbol, "source_rows": ",".join(line_refs),
            "source_records": _encode_records(records),
            "review_status": review_status,
        })

    for _, row in missing_isin_dividends.iterrows():
        records = json.loads(row["source_records"])
        duplicate = any(int(record["source_row"]) in duplicate_source_rows for record in records)
        out_rows.append({
            "date": row["date"], "isin": "", "currency": row["currency"],
            "gross_dividend": row["gross_dividend"], "withholding_tax": Decimal("0"),
            "withholding_tax_signed": Decimal("0"),
            "tax_adjustment_amount": Decimal("0"), "tax_sign_status": "",
            "symbol_or_product": row["symbol_or_product"],
            "source_rows": row["source_rows"], "source_records": row["source_records"],
            "review_status": "suspected_duplicate_transaction" if duplicate else "",
        })

    # Keep every tax row without an ISIN visible and unallocated. Its presence
    # alongside a dividend makes it ambiguous, never an automatic match.
    unresolved_tax_rows = []
    for tax in missing_isin_taxes.to_dict("records"):
        has_candidate = (
            div_agg["date"].eq(tax["date"])
            & div_agg["currency"].eq(tax["currency"])
        ).any()
        records = json.loads(tax["tax_source_records"])
        duplicate = any(int(record["source_row"]) in duplicate_source_rows for record in records)
        statuses = ["ambiguous_tax_match" if has_candidate else "unmatched_tax"]
        if duplicate:
            statuses.append("suspected_duplicate_transaction")
        unresolved_tax_rows.append({
            "date": tax["date"],
            "isin": "",
            "currency": tax["currency"],
            "gross_dividend": Decimal("0"),
            "symbol_or_product": tax["tax_description"],
            "withholding_tax": -tax["withholding_tax"],
            "withholding_tax_signed": tax["withholding_tax"],
            "tax_adjustment_amount": Decimal("0"), "tax_sign_status": "debit_candidate",
            "source_rows": tax["tax_source_rows"],
            "source_records": tax["tax_source_records"],
            "review_status": ";".join(statuses),
        })
    out_rows.extend(unresolved_tax_rows)

    # Positive entries remain visible as separate review items. They do not
    # change dividend net values or the reported withholding-tax total.
    for tax in positive_taxes.to_dict("records"):
        records = json.loads(tax["tax_source_records"])
        duplicate = any(int(record["source_row"]) in duplicate_source_rows for record in records)
        statuses = ["tax_adjustment_unverified"]
        if duplicate:
            statuses.append("suspected_duplicate_transaction")
        out_rows.append({
            "date": tax["date"], "isin": tax["isin"], "currency": tax["currency"],
            "gross_dividend": Decimal("0"), "withholding_tax": Decimal("0"),
            "withholding_tax_signed": tax["withholding_tax"],
            "tax_adjustment_amount": tax["withholding_tax"],
            "tax_sign_status": "positive_adjustment_unverified",
            "symbol_or_product": tax["tax_description"],
            "source_rows": tax["tax_source_rows"],
            "source_records": tax["tax_source_records"],
            "review_status": ";".join(statuses),
        })

    output = []
    for row in out_rows:
        gross = row["gross_dividend"]
        tax = row["withholding_tax"]
        output.append({
            "broker": "IBKR", "date": row["date"],
            "symbol_or_product": row["symbol_or_product"], "isin": row["isin"],
            "currency": row["currency"], "gross_dividend": gross,
            "withholding_tax": tax,
            "withholding_tax_signed": row["withholding_tax_signed"],
            "tax_adjustment_amount": row["tax_adjustment_amount"],
            "tax_sign_status": row["tax_sign_status"],
            "net_dividend": exact_decimal_sum([gross, row["withholding_tax_signed"]])
            if row["tax_sign_status"] == "debit_candidate" else gross,
            "source_file": _source_file_name(csv_path), "source_rows": row["source_rows"],
            "source_records": row["source_records"],
            "review_status": row["review_status"],
        })
    result = pd.DataFrame(output, columns=DETAIL_COLUMNS)
    if not result.empty:
        result = result.sort_values(["date", "symbol_or_product"]).reset_index(drop=True)
    result.attrs["diagnostics"] = diagnostics
    result.attrs["warnings"] = [item["message"] for item in diagnostics]
    return result


# =========================
# Combine / export
# =========================

def process_files(degiro_files: Iterable[str], ibkr_files: Iterable[str]) -> pd.DataFrame:
    frames = []
    diagnostics = []
    seen_paths = set()
    seen_hashes = {}

    for broker, paths in (("DEGIRO", degiro_files), ("IBKR", ibkr_files)):
        for path in paths:
            file_path = Path(path)
            resolved_path = str(file_path.resolve())
            if resolved_path in seen_paths:
                _add_diagnostic(
                    diagnostics, file_path, "", "duplicate_file_path",
                    "Opakovaná cesta k souboru byla přeskočena.",
                )
                continue
            seen_paths.add(resolved_path)
            content_hash = hashlib.sha256(file_path.read_bytes()).hexdigest()
            hash_key = (broker, content_hash)
            if hash_key in seen_hashes:
                _add_diagnostic(
                    diagnostics, file_path, "", "duplicate_file_content",
                    f"Obsah souboru je totožný se souborem {seen_hashes[hash_key]!r}; kopie byla přeskočena.",
                )
                continue
            seen_hashes[hash_key] = str(file_path)
            parsed = parse_degiro(file_path) if broker == "DEGIRO" else parse_ibkr(file_path)
            frames.append(parsed)
            diagnostics.extend(parsed.attrs.get("diagnostics", []))

    if not frames:
        detail = pd.DataFrame(columns=DETAIL_COLUMNS)
        detail.attrs["diagnostics"] = diagnostics
        detail.attrs["warnings"] = [item["message"] for item in diagnostics]
        return detail

    detail = pd.concat(frames, ignore_index=True)
    detail = detail.sort_values(["date", "broker", "symbol_or_product"]).reset_index(drop=True)
    signatures = {}
    for index, row in detail.iterrows():
        signature = (
            row["broker"], row["date"], row["symbol_or_product"], row["isin"],
            row["currency"], row["gross_dividend"], row["withholding_tax"],
        )
        signatures.setdefault(signature, []).append(index)
    for indexes in signatures.values():
        source_paths = {detail.at[index, "source_file"] for index in indexes}
        if len(indexes) > 1 and len(source_paths) > 1:
            message = "Stejná normalizovaná transakce je ve více souborech; záznamy nebyly odstraněny."
            for index in indexes:
                existing = detail.at[index, "review_status"] or ""
                status = "suspected_duplicate_transaction"
                detail.at[index, "review_status"] = ";".join(
                    part for part in (existing, status) if part
                )
            _add_diagnostic(
                diagnostics,
                ", ".join(sorted(source_paths)),
                "",
                "suspected_duplicate_transaction",
                message,
            )
    detail.attrs["diagnostics"] = diagnostics
    detail.attrs["warnings"] = [item["message"] for item in diagnostics]
    return detail


def build_summary(detail_df: pd.DataFrame) -> pd.DataFrame:
    grouped = {}
    for _, row in detail_df.iterrows():
        key = (row["broker"], row["currency"])
        bucket = grouped.setdefault(key, {
            "gross": [], "tax": [], "net": [],
            "review_gross": [], "review_tax": [], "review_net": [],
            "confirmed_gross": [], "confirmed_tax": [], "confirmed_net": [],
        })
        bucket["gross"].append(row["gross_dividend"])
        bucket["tax"].append(row["withholding_tax"])
        bucket["net"].append(row["net_dividend"])
        partition = "review" if str(row.get("review_status", "")) else "confirmed"
        for metric, field in (("gross", "gross_dividend"), ("tax", "withholding_tax"), ("net", "net_dividend")):
            bucket[f"{partition}_{metric}"].append(row[field])
    rows = [
        {
            "broker": broker,
            "currency": currency,
            "gross_dividend": exact_decimal_sum(values["gross"]),
            "withholding_tax": exact_decimal_sum(values["tax"]),
            "net_dividend": exact_decimal_sum(values["net"]),
            "needs_review_gross_dividend": exact_decimal_sum(values["review_gross"]),
            "needs_review_withholding_tax": exact_decimal_sum(values["review_tax"]),
            "needs_review_net_dividend": exact_decimal_sum(values["review_net"]),
            "confirmed_gross_dividend": exact_decimal_sum(values["confirmed_gross"]),
            "confirmed_withholding_tax": exact_decimal_sum(values["confirmed_tax"]),
            "confirmed_net_dividend": exact_decimal_sum(values["confirmed_net"]),
        }
        for (broker, currency), values in sorted(grouped.items())
    ]
    return pd.DataFrame(rows, columns=[
        "broker", "currency", "gross_dividend", "withholding_tax", "net_dividend",
        "confirmed_gross_dividend", "confirmed_withholding_tax", "confirmed_net_dividend",
        "needs_review_gross_dividend", "needs_review_withholding_tax", "needs_review_net_dividend",
    ])


def build_yearly_summary(detail_df: pd.DataFrame) -> pd.DataFrame:
    grouped = {}
    for _, row in detail_df.iterrows():
        date = row["date"]
        year = date.year if hasattr(date, "year") else pd.Timestamp(date).year
        key = (year, row["broker"], row["currency"])
        bucket = grouped.setdefault(key, {
            "gross": [], "tax": [], "net": [],
            "review_gross": [], "review_tax": [], "review_net": [],
            "confirmed_gross": [], "confirmed_tax": [], "confirmed_net": [],
        })
        bucket["gross"].append(row["gross_dividend"])
        bucket["tax"].append(row["withholding_tax"])
        bucket["net"].append(row["net_dividend"])
        partition = "review" if str(row.get("review_status", "")) else "confirmed"
        for metric, field in (("gross", "gross_dividend"), ("tax", "withholding_tax"), ("net", "net_dividend")):
            bucket[f"{partition}_{metric}"].append(row[field])
    rows = [
        {
            "year": year,
            "broker": broker,
            "currency": currency,
            "gross_dividend": exact_decimal_sum(values["gross"]),
            "withholding_tax": exact_decimal_sum(values["tax"]),
            "net_dividend": exact_decimal_sum(values["net"]),
            "confirmed_gross_dividend": exact_decimal_sum(values["confirmed_gross"]),
            "confirmed_withholding_tax": exact_decimal_sum(values["confirmed_tax"]),
            "confirmed_net_dividend": exact_decimal_sum(values["confirmed_net"]),
            "needs_review_gross_dividend": exact_decimal_sum(values["review_gross"]),
            "needs_review_withholding_tax": exact_decimal_sum(values["review_tax"]),
            "needs_review_net_dividend": exact_decimal_sum(values["review_net"]),
        }
        for (year, broker, currency), values in sorted(grouped.items())
    ]
    return pd.DataFrame(rows, columns=[
        "year", "broker", "currency", "gross_dividend", "withholding_tax", "net_dividend",
        "confirmed_gross_dividend", "confirmed_withholding_tax", "confirmed_net_dividend",
        "needs_review_gross_dividend", "needs_review_withholding_tax", "needs_review_net_dividend",
    ])


def main() -> None:
    parser = argparse.ArgumentParser(description="Zpracování dividend z DEGIRO a IBKR")
    parser.add_argument("--degiro", nargs="*", default=[], help="CSV soubory z DEGIRO")
    parser.add_argument("--ibkr", nargs="*", default=[], help="CSV soubory z IBKR")
    parser.add_argument("--outdir", default="dividend_output", help="Výstupní adresář")
    args = parser.parse_args()

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    detail = process_files(args.degiro, args.ibkr)
    for warning in detail.attrs.get("warnings", []):
        print(f"Upozornění: {warning}")

    diagnostics = pd.DataFrame(detail.attrs.get("diagnostics", []), columns=DIAGNOSTIC_COLUMNS)
    diagnostics.to_csv(outdir / "dividend_diagnostics.csv", index=False)

    if detail.empty:
        print("Nebyla nalezena žádná zpracovatelná dividenda.")
        return

    summary = build_summary(detail)
    yearly_summary = build_yearly_summary(detail)

    detail.to_csv(outdir / "dividend_detail.csv", index=False)
    summary.to_csv(outdir / "dividend_summary_by_broker_currency.csv", index=False)
    yearly_summary.to_csv(outdir / "dividend_summary_by_year_broker_currency.csv", index=False)

    print("Hotovo.")
    print(detail.head(20).to_string(index=False))


if __name__ == "__main__":
    main()
