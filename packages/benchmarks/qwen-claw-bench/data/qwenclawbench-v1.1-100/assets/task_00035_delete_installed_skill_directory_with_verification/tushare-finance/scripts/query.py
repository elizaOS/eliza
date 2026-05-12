#!/usr/bin/env python3
"""Tushare Pro API query wrapper for OpenClaw."""

import os
import sys
import json
import argparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError

TUSHARE_API_URL = "http://api.tushare.pro"


def call_tushare(api_name: str, params: dict, fields: str = "") -> dict:
    """Call the Tushare Pro HTTP API."""
    token = os.environ.get("TUSHARE_TOKEN")
    if not token:
        print("Error: TUSHARE_TOKEN environment variable not set.", file=sys.stderr)
        print("Get a token at https://tushare.pro/register", file=sys.stderr)
        sys.exit(1)

    payload = {
        "api_name": api_name,
        "token": token,
        "params": params,
    }
    if fields:
        payload["fields"] = fields

    data = json.dumps(payload).encode("utf-8")
    req = Request(TUSHARE_API_URL, data=data, headers={"Content-Type": "application/json"})

    try:
        with urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        print(f"API error: {e.code} {e.reason}", file=sys.stderr)
        sys.exit(1)

    if result.get("code") != 0:
        print(f"Tushare error: {result.get('msg', 'unknown')}", file=sys.stderr)
        sys.exit(1)

    return result.get("data", {})


def print_table(data: dict):
    """Pretty-print Tushare response data as a table."""
    fields = data.get("fields", [])
    items = data.get("items", [])

    if not items:
        print("No data returned.")
        return

    # Calculate column widths
    widths = [len(str(f)) for f in fields]
    for row in items:
        for i, val in enumerate(row):
            widths[i] = max(widths[i], len(str(val) if val is not None else ""))

    # Header
    header = " | ".join(str(f).ljust(widths[i]) for i, f in enumerate(fields))
    print(header)
    print("-+-".join("-" * w for w in widths))

    # Rows
    for row in items:
        line = " | ".join(str(v if v is not None else "").ljust(widths[i]) for i, v in enumerate(row))
        print(line)

    print(f"\n({len(items)} rows)")


def main():
    parser = argparse.ArgumentParser(description="Query Tushare Pro API")
    parser.add_argument("api_name", help="API endpoint name (e.g. daily, stock_basic, income)")
    parser.add_argument("--ts_code", help="Stock code (e.g. 000001.SZ)")
    parser.add_argument("--trade_date", help="Trade date YYYYMMDD")
    parser.add_argument("--start_date", help="Start date YYYYMMDD")
    parser.add_argument("--end_date", help="End date YYYYMMDD")
    parser.add_argument("--exchange", help="Exchange: SSE or SZSE")
    parser.add_argument("--list_status", help="Listing status: L, D, P")
    parser.add_argument("--period", help="Report period YYYYMMDD")
    parser.add_argument("--fields", default="", help="Comma-separated fields to return")
    parser.add_argument("--json", action="store_true", help="Output as JSON")

    args = parser.parse_args()

    params = {}
    for key in ["ts_code", "trade_date", "start_date", "end_date", "exchange", "list_status", "period"]:
        val = getattr(args, key, None)
        if val:
            params[key] = val

    data = call_tushare(args.api_name, params, args.fields)

    if args.json:
        print(json.dumps(data, indent=2, ensure_ascii=False))
    else:
        print_table(data)


if __name__ == "__main__":
    main()
