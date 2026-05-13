#!/usr/bin/env python3
"""Verify that migrate_data.py correctly transforms the database."""

import json
import os
import sqlite3
import sys


DB_PATH = "/workspace/fixtures/test_data.db"

EXPECTED_TABLES = {
    "accounts": ["id", "email", "role_id", "created_at"],
    "profiles": ["id", "account_id", "display_name", "bio"],
    "products": ["id", "name", "description", "price_cents", "category"],
    "orders": ["id", "account_id", "product_id", "quantity", "total_price_cents", "status_code", "ordered_at"],
    "reviews": ["id", "account_id", "product_id", "rating", "comment", "reviewed_at"],
    "activity_log": ["id", "account_id", "action", "details", "logged_at"],
}

OLD_TABLES = ["users", "audit_log"]


def get_tables(conn):
    cur = conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    return [row[0] for row in cur.fetchall()]


def get_columns(conn, table):
    cur = conn.execute(f"PRAGMA table_info({table})")
    return [row[1] for row in cur.fetchall()]


def main():
    result = {
        "script_exists": False,
        "schema_checks": {},
        "data_checks": {},
        "schema_score": 0.0,
        "data_score": 0.0,
        "overall_score": 0.0,
    }

    if not os.path.isfile(DB_PATH):
        print(json.dumps(result))
        return

    result["script_exists"] = os.path.isfile("/workspace/migrate_data.py")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    tables = get_tables(conn)

    # ── Schema structure checks ──
    schema_checks = {}
    schema_points = 0.0
    per_table_weight = 1.0 / len(EXPECTED_TABLES)

    for tbl, exp_cols in EXPECTED_TABLES.items():
        check = {"exists": tbl in tables, "columns_match": False}
        if check["exists"]:
            actual_cols = get_columns(conn, tbl)
            check["expected_columns"] = exp_cols
            check["actual_columns"] = actual_cols
            check["columns_match"] = set(exp_cols) == set(actual_cols)
            if check["columns_match"]:
                schema_points += per_table_weight
            elif set(exp_cols).issubset(set(actual_cols)):
                schema_points += per_table_weight * 0.5
        schema_checks[tbl] = check

    result["schema_checks"] = schema_checks
    result["schema_score"] = round(schema_points, 4)

    # ── Data integrity checks (15 checks) ──
    data_checks = {}
    data_points = 0.0
    num_data_checks = 15

    # 1. Account count: 15 users - 2 deduped (users 3, 9 merge into 1) = 13
    try:
        count = conn.execute("SELECT COUNT(*) FROM accounts").fetchone()[0]
        ok = count == 13
        data_checks["account_count"] = {"expected": 13, "actual": count, "pass": ok}
        if ok:
            data_points += 1
    except Exception as e:
        data_checks["account_count"] = {"pass": False, "error": str(e)}

    # 2. Email uniqueness and normalization (lowercase, trimmed)
    try:
        emails = [r[0] for r in conn.execute("SELECT email FROM accounts ORDER BY email").fetchall()]
        all_lower = all(e == e.lower() for e in emails)
        all_trimmed = all(e == e.strip() for e in emails)
        no_dupes = len(emails) == len(set(emails))
        ok = all_lower and all_trimmed and no_dupes
        data_checks["email_normalization"] = {
            "all_lowercase": all_lower,
            "all_trimmed": all_trimmed,
            "no_duplicates": no_dupes,
            "count": len(emails),
            "pass": ok,
        }
        if ok:
            data_points += 1
    except Exception as e:
        data_checks["email_normalization"] = {"pass": False, "error": str(e)}

    # 3. Role mapping with case normalization
    try:
        rows = conn.execute("SELECT email, role_id FROM accounts ORDER BY id").fetchall()
        role_ok = True
        details = []
        # Expected after dedup and case normalization:
        expected_roles = {
            "alice@example.com": 2,    # admin
            "bob@example.com": 1,      # active
            "carol@example.com": 1,    # active
            "dave@example.com": 3,     # inactive
            "eve@example.com": 0,      # Pending → pending → 0
            "frank@example.com": 1,    # ACTIVE → active → 1
            "grace@example.com": 2,    # Admin → admin → 2
            "henry@example.com": 1,    # active
            "iris@example.com": 1,     # active
            "jack@example.com": 0,     # pending
            "kate@example.com": 1,     # active
            "leo@example.com": 3,      # inactive
            "mike@example.com": 1,     # active
        }
        for row in rows:
            email_lower = row[0].lower().strip()
            exp_role = expected_roles.get(email_lower)
            if exp_role is not None and row[1] != exp_role:
                role_ok = False
                details.append(f"{email_lower}: got {row[1]}, expected {exp_role}")
        data_checks["role_mapping"] = {"pass": role_ok, "issues": details}
        if role_ok:
            data_points += 1
    except Exception as e:
        data_checks["role_mapping"] = {"pass": False, "error": str(e)}

    # 4. Profiles: correct count, Anonymous backfill for NULL names
    try:
        rows = conn.execute(
            "SELECT p.display_name FROM profiles p JOIN accounts a ON p.account_id = a.id"
        ).fetchall()
        anon_count = sum(1 for r in rows if r[0] == "Anonymous")
        # Users 5 and 12 have NULL names (users 3, 9 are deduped into user 1 who has a name)
        # User 10 has empty string '' - could be '' or 'Anonymous', accept either
        ok = len(rows) == 13 and anon_count >= 2
        data_checks["profiles_backfill"] = {
            "total_profiles": len(rows),
            "anonymous_count": anon_count,
            "pass": ok,
        }
        if ok:
            data_points += 1
    except Exception as e:
        data_checks["profiles_backfill"] = {"pass": False, "error": str(e)}

    # 5. Price conversion: REAL dollars → INTEGER cents
    try:
        rows = conn.execute("SELECT id, price_cents FROM products ORDER BY id").fetchall()
        # round(29.99*100)=2999, round(49.50*100)=4950, round(9.99*100)=999,
        # round(149.99*100)=14999, round(4.95*100)=495,
        # round(0.001*100)=0, NULL→0, round(0.00*100)=0
        expected_cents = {1: 2999, 2: 4950, 3: 999, 4: 14999, 5: 495, 6: 0, 7: 0, 8: 0}
        matches = sum(1 for r in rows if expected_cents.get(r[0]) == r[1])
        ok = matches == len(expected_cents)
        data_checks["price_conversion"] = {
            "matches": matches,
            "total": len(expected_cents),
            "pass": ok,
        }
        if ok:
            data_points += 1
    except Exception as e:
        data_checks["price_conversion"] = {"pass": False, "error": str(e)}

    # 6. Category normalization (trimmed, NULL → 'general')
    try:
        rows = conn.execute("SELECT id, category FROM products ORDER BY id").fetchall()
        cat_ok = True
        for r in rows:
            if r[1] is None:
                cat_ok = False
            elif r[1] != r[1].strip():
                cat_ok = False
        # Product 3 had NULL category → 'general'
        p3_cat = dict(rows).get(3)
        if p3_cat != "general":
            cat_ok = False
        # Product 6 had ' electronics ' → 'electronics'
        p6_cat = dict(rows).get(6)
        if p6_cat != "electronics":
            cat_ok = False
        data_checks["category_normalization"] = {"pass": cat_ok}
        if cat_ok:
            data_points += 1
    except Exception as e:
        data_checks["category_normalization"] = {"pass": False, "error": str(e)}

    # 7. NULL rating backfill + out-of-range clamping
    try:
        null_ratings = conn.execute(
            "SELECT COUNT(*) FROM reviews WHERE rating IS NULL"
        ).fetchone()[0]
        out_of_range = conn.execute(
            "SELECT COUNT(*) FROM reviews WHERE rating < 1 OR rating > 5"
        ).fetchone()[0]
        # Ratings 0, -1 should be clamped to 1; rating 6 should be clamped to 5
        # NULL ratings (3 of them) should be backfilled to 3
        ok = null_ratings == 0 and out_of_range == 0
        data_checks["rating_normalization"] = {
            "null_ratings_remaining": null_ratings,
            "out_of_range_remaining": out_of_range,
            "pass": ok,
        }
        if ok:
            data_points += 1
    except Exception as e:
        data_checks["rating_normalization"] = {"pass": False, "error": str(e)}

    # 8. Old tables removed
    try:
        tables_now = get_tables(conn)
        users_gone = "users" not in tables_now
        audit_gone = "audit_log" not in tables_now
        ok = users_gone and audit_gone
        data_checks["old_tables_removed"] = {
            "users_removed": users_gone,
            "audit_log_removed": audit_gone,
            "pass": ok,
        }
        if ok:
            data_points += 1
    except Exception as e:
        data_checks["old_tables_removed"] = {"pass": False, "error": str(e)}

    # 9. FK integrity: all orders reference valid accounts
    try:
        orphans = conn.execute(
            "SELECT COUNT(*) FROM orders o LEFT JOIN accounts a ON o.account_id = a.id WHERE a.id IS NULL"
        ).fetchone()[0]
        ok = orphans == 0
        data_checks["order_fk_integrity"] = {"orphan_orders": orphans, "pass": ok}
        if ok:
            data_points += 1
    except Exception as e:
        data_checks["order_fk_integrity"] = {"pass": False, "error": str(e)}

    # 10. Quantity constraint: no zero or negative quantities
    try:
        bad_qty = conn.execute(
            "SELECT COUNT(*) FROM orders WHERE quantity <= 0"
        ).fetchone()[0]
        ok = bad_qty == 0
        data_checks["quantity_constraint"] = {"bad_quantities": bad_qty, "pass": ok}
        if ok:
            data_points += 1
    except Exception as e:
        data_checks["quantity_constraint"] = {"pass": False, "error": str(e)}

    # 11. Status code mapping with case normalization
    try:
        rows = conn.execute("SELECT id, status_code FROM orders ORDER BY id").fetchall()
        # Expected status codes:
        expected_status = {
            1: 2, 2: 1, 3: 0, 4: 2, 5: 3, 6: 1, 7: 2, 8: 0, 9: 1, 10: 2,
            11: 0, 12: 1, 13: 2, 14: 0,  # "Pending" → 0
            15: 1, 16: 2,                  # "DELIVERED" → 2
            17: 1, 18: 3, 19: 0, 20: 2,
        }
        matches = sum(1 for r in rows if expected_status.get(r[0]) == r[1])
        ok = matches == len(expected_status)
        data_checks["status_mapping"] = {
            "matches": matches,
            "total": len(expected_status),
            "pass": ok,
        }
        if ok:
            data_points += 1
    except Exception as e:
        data_checks["status_mapping"] = {"pass": False, "error": str(e)}

    # 12. User ID remapping: orders for deduped users (3, 9) should map to user 1
    try:
        # Old orders 12 (user_id=9) and 13 (user_id=3) should now reference account 1
        order_12 = conn.execute("SELECT account_id FROM orders WHERE id=12").fetchone()
        order_13 = conn.execute("SELECT account_id FROM orders WHERE id=13").fetchone()
        ok = (order_12 is not None and order_12[0] == 1 and
              order_13 is not None and order_13[0] == 1)
        data_checks["user_id_remapping_orders"] = {"pass": ok}
        if ok:
            data_points += 1
    except Exception as e:
        data_checks["user_id_remapping_orders"] = {"pass": False, "error": str(e)}

    # 13. Review FK integrity: all reviews reference valid accounts
    try:
        orphans = conn.execute(
            "SELECT COUNT(*) FROM reviews r LEFT JOIN accounts a ON r.account_id = a.id WHERE a.id IS NULL"
        ).fetchone()[0]
        ok = orphans == 0
        data_checks["review_fk_integrity"] = {"orphan_reviews": orphans, "pass": ok}
        if ok:
            data_points += 1
    except Exception as e:
        data_checks["review_fk_integrity"] = {"pass": False, "error": str(e)}

    # 14. Activity log FK + rename: all entries reference valid accounts
    try:
        count = conn.execute("SELECT COUNT(*) FROM activity_log").fetchone()[0]
        orphans = conn.execute(
            "SELECT COUNT(*) FROM activity_log a LEFT JOIN accounts ac ON a.account_id = ac.id WHERE ac.id IS NULL"
        ).fetchone()[0]
        ok = count == 12 and orphans == 0
        data_checks["activity_log_integrity"] = {
            "count": count,
            "expected": 12,
            "orphans": orphans,
            "pass": ok,
        }
        if ok:
            data_points += 1
    except Exception as e:
        data_checks["activity_log_integrity"] = {"pass": False, "error": str(e)}

    # 15. NOT NULL constraints: no NULL values in required fields
    try:
        null_issues = []
        for tbl, cols in [
            ("accounts", ["email", "created_at"]),
            ("orders", ["ordered_at"]),
            ("reviews", ["reviewed_at"]),
        ]:
            for col in cols:
                null_count = conn.execute(
                    f"SELECT COUNT(*) FROM {tbl} WHERE {col} IS NULL"
                ).fetchone()[0]
                if null_count > 0:
                    null_issues.append(f"{tbl}.{col}: {null_count} NULLs")
        ok = len(null_issues) == 0
        data_checks["not_null_constraints"] = {"issues": null_issues, "pass": ok}
        if ok:
            data_points += 1
    except Exception as e:
        data_checks["not_null_constraints"] = {"pass": False, "error": str(e)}

    result["data_checks"] = data_checks
    result["data_score"] = round(data_points / num_data_checks, 4)

    # Overall: 5% script exists, 10% runs clean (checked separately), 35% schema, 50% data
    score = 0.0
    if result["script_exists"]:
        score += 0.05
    score += 0.35 * result["schema_score"]
    score += 0.50 * result["data_score"]
    result["overall_score"] = round(score, 4)

    print(json.dumps(result))
    conn.close()


if __name__ == "__main__":
    main()
