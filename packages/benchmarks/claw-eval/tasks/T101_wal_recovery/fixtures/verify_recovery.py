#!/usr/bin/env python3
"""Verify recovered.json against expected data and check WAL fix."""

import json
import math
import os
import sqlite3
import sys


EXPECTED = json.loads('[{"id": 1, "name": "alpha", "value": 99.9}, {"id": 2, "name": "beta", "value": 88.8}, {"id": 3, "name": "gamma", "value": 30.7}, {"id": 4, "name": "delta", "value": 40.1}, {"id": 5, "name": "epsilon", "value": 50.9}, {"id": 6, "name": "zeta", "value": 60.2}, {"id": 7, "name": "eta", "value": 70.4}, {"id": 8, "name": "theta", "value": 80.6}, {"id": 9, "name": "iota", "value": 90.8}, {"id": 10, "name": "kappa", "value": 100.0}, {"id": 11, "name": "lambda", "value": 110.5}]')
RECOVERED_PATH = "/workspace/recovered.json"
DB_PATH = "/workspace/fixtures/test.db"


def main():
    result = {
        "json_exists": False,
        "record_count": 0,
        "expected_count": len(EXPECTED),
        "correct_records": 0,
        "values_correct": 0,
        "db_row_count": 0,
        "wal_fixed": False,
        "per_record": {},
    }

    # Check if recovered.json exists
    if not os.path.isfile(RECOVERED_PATH):
        print(json.dumps(result))
        return

    result["json_exists"] = True

    # Parse recovered.json
    try:
        with open(RECOVERED_PATH) as f:
            recovered = json.load(f)
    except (json.JSONDecodeError, Exception) as e:
        result["parse_error"] = str(e)
        print(json.dumps(result))
        return

    if not isinstance(recovered, list):
        result["parse_error"] = "Expected a JSON array"
        print(json.dumps(result))
        return

    result["record_count"] = len(recovered)

    # Build lookup by id
    recovered_by_id = {}
    for rec in recovered:
        if isinstance(rec, dict) and "id" in rec:
            recovered_by_id[rec["id"]] = rec

    # Compare each expected record
    correct = 0
    values_ok = 0
    for exp in EXPECTED:
        rid = exp["id"]
        got = recovered_by_id.get(rid)
        rec_result = {"found": False, "name_ok": False, "value_ok": False}

        if got is not None:
            rec_result["found"] = True

            # Check name
            if got.get("name") == exp["name"]:
                rec_result["name_ok"] = True

            # Check value (float tolerance)
            try:
                got_val = float(got.get("value", 0))
                exp_val = float(exp["value"])
                if math.isclose(got_val, exp_val, rel_tol=1e-4, abs_tol=0.01):
                    rec_result["value_ok"] = True
                    values_ok += 1
            except (TypeError, ValueError):
                pass

            if rec_result["name_ok"] and rec_result["value_ok"]:
                correct += 1

        result["per_record"][str(rid)] = rec_result

    result["correct_records"] = correct
    result["values_correct"] = values_ok

    # Check if WAL was actually fixed (DB reads all 11 rows via SQLite)
    try:
        conn = sqlite3.connect(DB_PATH)
        rows = conn.execute("SELECT * FROM items ORDER BY id").fetchall()
        conn.close()
        result["db_row_count"] = len(rows)
        result["wal_fixed"] = len(rows) == len(EXPECTED)
    except Exception as e:
        result["db_error"] = str(e)

    print(json.dumps(result))


if __name__ == "__main__":
    main()
