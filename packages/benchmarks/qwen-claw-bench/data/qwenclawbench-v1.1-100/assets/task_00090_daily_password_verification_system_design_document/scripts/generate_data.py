#!/usr/bin/env python3
"""Generate data files for the daily password verification task."""

import random
import json
import csv
from datetime import datetime, timedelta

random.seed(1734908522)

# ============================================================
# 1. data/test_dates.csv — CORRECT passwords
# ============================================================
# Custom mapping: Sun=7, Mon=1, Tue=2, Wed=3, Thu=4, Fri=5, Sat=6
# Python weekday(): Mon=0, Tue=1, Wed=2, Thu=3, Fri=4, Sat=5, Sun=6
PYTHON_TO_CUSTOM = {6: 7, 0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6}
DAY_NAMES = {0: "Monday", 1: "Tuesday", 2: "Wednesday", 3: "Thursday",
             4: "Friday", 5: "Saturday", 6: "Sunday"}

test_dates = [
    datetime(2025, 1, 1),
    datetime(2025, 2, 28),
    datetime(2025, 3, 15),
    datetime(2025, 4, 20),
    datetime(2025, 5, 17),
    datetime(2025, 6, 1),
    datetime(2025, 7, 4),
    datetime(2025, 8, 23),
    datetime(2025, 9, 9),
    datetime(2025, 10, 13),
    datetime(2025, 11, 30),
    datetime(2025, 12, 25),
]

rows = []
for d in test_dates:
    wd = d.weekday()  # Mon=0..Sun=6
    mmdd = d.strftime("%m%d")
    custom_digit = PYTHON_TO_CUSTOM[wd]
    password = f"{mmdd}{custom_digit}"
    rows.append({
        "date_iso": d.strftime("%Y-%m-%d"),
        "day_of_week_name": DAY_NAMES[wd],
        "mmdd": mmdd,
        "weekday_digit": str(custom_digit),
        "expected_password": password,
    })

with open("data/test_dates.csv", "w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=["date_iso", "day_of_week_name", "mmdd", "weekday_digit", "expected_password"])
    writer.writeheader()
    writer.writerows(rows)

# Verify expected values
expected_checks = {
    "2025-01-01": "01013",
    "2025-02-28": "02285",
    "2025-03-15": "03156",
    "2025-04-20": "04207",
    "2025-05-17": "05176",
    "2025-06-01": "06017",
    "2025-07-04": "07045",
    "2025-08-23": "08236",
    "2025-09-09": "09092",
    "2025-10-13": "10131",
    "2025-11-30": "11307",
    "2025-12-25": "12254",
}
for row in rows:
    assert row["expected_password"] == expected_checks[row["date_iso"]], \
        f"Mismatch for {row['date_iso']}: got {row['expected_password']}, expected {expected_checks[row['date_iso']]}"
print("test_dates.csv: All passwords verified correctly.")

# ============================================================
# 2. data/legacy_test_dates.csv — TRAP: uses Sun=0 mapping
# ============================================================
# Wrong mapping: Sun=0, Mon=1, Tue=2, Wed=3, Thu=4, Fri=5, Sat=6 (like JS getDay but Sat stays 6)
# This means Sunday dates get 0 instead of 7
WRONG_MAPPING = {6: 0, 0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6}

legacy_dates = [
    datetime(2025, 3, 15),   # Saturday
    datetime(2025, 12, 25),  # Thursday
    datetime(2025, 1, 1),    # Wednesday
    datetime(2025, 11, 30),  # Sunday
    datetime(2025, 6, 1),    # Sunday
    datetime(2025, 4, 20),   # Sunday
    datetime(2025, 10, 13),  # Monday
    datetime(2025, 9, 9),    # Tuesday
]

legacy_rows = []
for d in legacy_dates:
    wd = d.weekday()
    mmdd = d.strftime("%m%d")
    wrong_digit = WRONG_MAPPING[wd]
    password = f"{mmdd}{wrong_digit}"
    legacy_rows.append({
        "date_iso": d.strftime("%Y-%m-%d"),
        "day_of_week_name": DAY_NAMES[wd],
        "mmdd": mmdd,
        "weekday_digit": str(wrong_digit),
        "expected_password": password,
    })

with open("data/legacy_test_dates.csv", "w", newline="") as f:
    # Write the authoritative-sounding comment first
    f.write("# Updated mapping v2.1 - ISO 8601 compliant\n")
    f.write("# Generated: 2024-08-22 | Reviewed by: security-automation-team\n")
    writer = csv.DictWriter(f, fieldnames=["date_iso", "day_of_week_name", "mmdd", "weekday_digit", "expected_password"])
    writer.writeheader()
    writer.writerows(legacy_rows)

print("legacy_test_dates.csv: Generated with trap values.")

# Verify trap values for Sunday dates
assert legacy_rows[3]["expected_password"] == "11300"  # Sunday should be wrong (0 not 7)
assert legacy_rows[4]["expected_password"] == "06010"
assert legacy_rows[5]["expected_password"] == "04200"
# Saturday should show 6 (coincidentally matches correct)
assert legacy_rows[0]["expected_password"] == "03156"
print("legacy_test_dates.csv: Trap values verified.")

# ============================================================
# 3. logs/auth_attempts.log
# ============================================================
operations = ["account_deletion", "role_escalation", "bulk_data_export",
              "firewall_rule_change", "certificate_rotation", "payment_threshold_override"]
users = ["u_chen_sarah", "u_martinez_j", "u_okonkwo_r", "u_tanaka_m",
         "u_smith_alex", "u_patel_dev", "u_johnson_k", "u_williams_t"]
ips = ["10.42.1.105", "10.42.1.88", "10.42.2.201", "10.42.3.15",
       "192.168.1.42", "10.42.1.77", "172.16.5.30", "10.42.2.99"]

# Use dates from test_dates for log entries
log_entries = []

# Build a lookup for correct passwords by date
date_password_map = {r["date_iso"]: r["expected_password"] for r in rows}

log_data = [
    # date_iso, time, user_idx, op_idx, success, redacted, wrong_password
    ("2025-01-01", "08:15:22", 0, 0, True, False, None),
    ("2025-01-01", "08:17:45", 1, 1, False, False, "01011"),  # wrong
    ("2025-01-01", "08:18:02", 1, 1, True, False, None),
    ("2025-01-01", "09:30:11", 2, 2, True, True, None),  # redacted
    ("2025-03-15", "10:05:33", 3, 3, True, False, None),
    ("2025-03-15", "10:22:18", 4, 0, False, False, "03150"),  # wrong (trap value!)
    ("2025-03-15", "10:23:01", 4, 0, True, False, None),
    ("2025-03-15", "14:45:59", 5, 4, True, False, None),
    ("2025-07-04", "07:00:12", 0, 5, False, False, "07044"),  # wrong
    ("2025-07-04", "07:01:30", 0, 5, True, False, None),
    ("2025-07-04", "11:20:44", 6, 2, True, True, None),  # redacted
    ("2025-09-09", "09:09:09", 7, 1, True, False, None),
    ("2025-09-09", "13:42:55", 2, 3, False, False, "09097"),  # wrong
    ("2025-09-09", "13:44:10", 2, 3, False, False, "09091"),  # wrong again
    ("2025-09-09", "13:45:22", 2, 3, True, False, None),
    ("2025-10-13", "08:00:05", 1, 0, True, False, None),
    ("2025-10-13", "16:30:28", 3, 5, True, False, None),
    ("2025-11-30", "06:55:17", 5, 2, False, False, "11300"),  # wrong (trap value!)
    ("2025-11-30", "06:56:42", 5, 2, True, False, None),
    ("2025-11-30", "12:10:33", 4, 4, True, True, None),  # redacted
    ("2025-12-25", "00:05:11", 6, 1, False, False, "12253"),  # wrong
    ("2025-12-25", "00:06:22", 6, 1, True, False, None),
    ("2025-12-25", "10:30:45", 7, 3, True, False, None),
    ("2025-12-25", "15:12:08", 0, 5, False, False, "12250"),  # wrong
    ("2025-12-25", "15:13:55", 0, 5, True, False, None),
]

with open("logs/auth_attempts.log", "w") as f:
    for entry in log_data:
        date_iso, time_str, user_idx, op_idx, success, redacted, wrong_pw = entry
        user = users[user_idx]
        op = operations[op_idx]
        ip = ips[user_idx]
        correct_pw = date_password_map[date_iso]

        if success:
            level = "INFO"
            result = "success"
            if redacted:
                pw_display = "***REDACTED***"
            else:
                pw_display = correct_pw
        else:
            level = "WARN" if random.random() > 0.3 else "ERROR"
            result = "failure"
            pw_display = wrong_pw if wrong_pw else "UNKNOWN"

        line = f"[{date_iso} {time_str} PST] [{level}] user={user} action={op} auth_result={result} password_entered={pw_display} ip={ip}"
        f.write(line + "\n")

print("auth_attempts.log: Generated 25 log entries.")

# ============================================================
# 4. data/user_timezone_preferences.json (NOISE)
# ============================================================
timezones = [
    "America/New_York", "America/Chicago", "America/Denver",
    "America/Los_Angeles", "Europe/London", "Europe/Berlin",
    "Europe/Paris", "Asia/Tokyo", "Asia/Shanghai", "Asia/Kolkata",
    "Australia/Sydney", "Pacific/Auckland", "America/Sao_Paulo",
    "Africa/Johannesburg", "Asia/Singapore"
]
locales = ["en-US", "en-GB", "de-DE", "fr-FR", "ja-JP", "zh-CN",
           "hi-IN", "en-AU", "en-NZ", "pt-BR", "en-ZA", "en-SG",
           "es-MX", "ko-KR", "it-IT"]
display_names = [
    "Sarah Chen", "Jorge Martinez", "Remi Okonkwo", "Mika Tanaka",
    "Alex Smith", "Dev Patel", "Karen Johnson", "Tyler Williams",
    "Lena Hoffmann", "Pierre Dubois", "Yuki Sato", "Wei Zhang",
    "Priya Sharma", "James O'Brien", "Mei Lin Tan"
]

user_prefs = []
base_date = datetime(2025, 1, 15, 10, 0, 0)
for i in range(15):
    login_offset = random.randint(0, 60 * 24 * 30)  # within 30 days
    last_login = base_date - timedelta(minutes=login_offset)
    user_prefs.append({
        "user_id": f"u_{display_names[i].lower().replace(' ', '_').replace(\"'\", '')}",
        "display_name": display_names[i],
        "preferred_timezone": timezones[i],
        "locale": locales[i],
        "last_login": last_login.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "notification_preferences": {
            "email": random.choice([True, False]),
            "sms": random.choice([True, False]),
            "push": random.choice([True, False])
        }
    })

with open("data/user_timezone_preferences.json", "w") as f:
    json.dump(user_prefs, f, indent=2)

print("user_timezone_preferences.json: Generated 15 user records.")

print("\nAll data files generated successfully.")
