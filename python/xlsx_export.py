"""Create a small XLSX workbook from JSON without converting money to float."""

from __future__ import annotations

import json
import io
import re
import sys
import zipfile
from xml.sax.saxutils import escape


DECIMAL = re.compile(r"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$")


def column_name(index: int) -> str:
    result = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result


def xml_text(value: object) -> str:
    text = "".join(
        char if ord(char) in (9, 10, 13) or 0x20 <= ord(char) <= 0xD7FF or 0xE000 <= ord(char) <= 0xFFFD else "\uFFFD"
        for char in str(value)
    )
    return escape(text, {"\"": "&quot;"})


def cell_xml(row_number: int, column_number: int, value: object, numeric: bool) -> str:
    reference = f"{column_name(column_number)}{row_number}"
    if value is None or value == "":
        return f'<c r="{reference}"/>'
    if numeric:
        text = str(value)
        if not DECIMAL.fullmatch(text):
            raise ValueError("Invalid decimal value")
        return f'<c r="{reference}" s="1" t="n"><v>{text}</v></c>'
    text = xml_text(value)
    preserve = ' xml:space="preserve"' if str(value).strip() != str(value) else ""
    return f'<c r="{reference}" t="inlineStr"><is><t{preserve}>{text}</t></is></c>'


def create_xlsx(payload: dict) -> bytes:
    header = payload.get("header")
    rows = payload.get("rows")
    numeric_columns = payload.get("numeric_columns")
    if not isinstance(header, list) or not header or not all(isinstance(item, str) for item in header):
        raise ValueError("Invalid workbook header")
    if not isinstance(rows, list) or not isinstance(numeric_columns, list):
        raise ValueError("Invalid workbook rows")
    if any(not isinstance(row, list) or len(row) != len(header) for row in rows):
        raise ValueError("Invalid workbook row")
    if any(not isinstance(index, int) or index < 0 or index >= len(header) for index in numeric_columns):
        raise ValueError("Invalid numeric column")

    sheet_rows = []
    all_rows = [header, *rows]
    for row_number, row in enumerate(all_rows, start=1):
        cells = "".join(
            cell_xml(row_number, column_number, value, row_number > 1 and column_number - 1 in numeric_columns)
            for column_number, value in enumerate(row, start=1)
        )
        sheet_rows.append(f'<row r="{row_number}">{cells}</row>')
    last_cell = f"{column_name(len(header))}{max(1, len(all_rows))}"
    sheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<dimension ref="A1:{last_cell}"/>'
        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" '
        'activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
        '<sheetFormatPr defaultRowHeight="15"/>'
        f'<sheetData>{"".join(sheet_rows)}</sheetData>'
        f'<autoFilter ref="A1:{last_cell}"/></worksheet>'
    )
    files = {
        "[Content_Types].xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            '</Types>'
        ),
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '</Relationships>'
        ),
        "xl/workbook.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheets><sheet name="Dividendy" sheetId="1" r:id="rId1"/></sheets></workbook>'
        ),
        "xl/_rels/workbook.xml.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            '</Relationships>'
        ),
        "xl/styles.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.00##############"/></numFmts>'
            '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
            '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
            '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
            '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
            '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
            '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
            '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
            '</styleSheet>'
        ),
        "xl/worksheets/sheet1.xml": sheet,
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content.encode("utf-8"))
    return output.getvalue()


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        sys.stdout.buffer.write(create_xlsx(payload))
    except Exception:
        sys.stderr.write("XLSX export failed\n")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
