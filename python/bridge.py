"""Versioned JSON adapter for the local web application."""

from __future__ import annotations

import json
import io
import sys
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

import dividendy  # noqa: E402


CONTRACT_VERSION = 2


def _json_value(value):
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if hasattr(value, "item"):
        return _json_value(value.item())
    if value != value:  # NaN from pandas, never emit non-standard JSON numbers.
        return None
    raise TypeError(f"Unsupported bridge value type: {type(value).__name__}")


def process(request: dict) -> dict:
    if request.get("contract_version") != CONTRACT_VERSION:
        raise ValueError("Unsupported bridge contract version")
    broker = request.get("broker")
    if broker not in {"DEGIRO", "IBKR"}:
        raise ValueError("Unsupported broker")
    csv_text = request.get("csv_text")
    source_name = request.get("source_name")
    if not isinstance(csv_text, str) or not isinstance(source_name, str) or not source_name:
        raise ValueError("CSV text and source name are required")
    source_stream = io.StringIO(csv_text)
    source_stream.name = source_name

    result = (
        dividendy.parse_degiro(source_stream)
        if broker == "DEGIRO"
        else dividendy.parse_ibkr(source_stream)
    )
    transactions = []
    for row in result.to_dict("records"):
        source_records = row.get("source_records") or "[]"
        if isinstance(source_records, str):
            source_records = json.loads(source_records)
        transactions.append({
            "broker": broker,
            "date": _json_value(row.get("date")),
            "symbol_or_product": _json_value(row.get("symbol_or_product")),
            "isin": _json_value(row.get("isin")),
            "currency": _json_value(row.get("currency")),
            "gross_dividend": _json_value(row.get("gross_dividend")),
            "withholding_tax": _json_value(row.get("withholding_tax")),
            "withholding_tax_signed": _json_value(row.get("withholding_tax_signed")),
            "tax_adjustment_amount": _json_value(row.get("tax_adjustment_amount")),
            "tax_sign_status": _json_value(row.get("tax_sign_status")),
            "net_dividend": _json_value(row.get("net_dividend")),
            "source_file": _json_value(row.get("source_file")),
            "source_rows": _json_value(row.get("source_rows")),
            "source_records": _json_value(source_records),
            "review_status": _json_value(row.get("review_status")) or "",
        })

    diagnostics = []
    for diagnostic in result.attrs.get("diagnostics", []):
        diagnostics.append({key: _json_value(value) for key, value in diagnostic.items()})
    return {
        "contract_version": CONTRACT_VERSION,
        "broker": broker,
        "transactions": transactions,
        "diagnostics": diagnostics,
    }


def main() -> int:
    try:
        request = json.load(sys.stdin)
        response = process(request)
        sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as exc:
        # Do not put parser exceptions or any source values in process logs.
        sys.stderr.write(f"Dividend parser request failed ({type(exc).__name__}).\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
