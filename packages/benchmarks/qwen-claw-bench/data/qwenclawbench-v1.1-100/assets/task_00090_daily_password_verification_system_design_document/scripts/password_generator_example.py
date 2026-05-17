#!/usr/bin/env python3
"""
Daily Password Generator — Reference Implementation

Generates and verifies the dynamic daily password used for high-risk
operation authorization. See requirements/password_policy.md for the
full specification.

Password Rule:
    password = MMDD + weekday_digit

Where:
    - MMDD is the zero-padded month and day (e.g., Jan 1 = "0101")
    - weekday_digit is derived from the custom mapping:
        Sunday=7, Monday=1, Tuesday=2, Wednesday=3,
        Thursday=4, Friday=5, Saturday=6

All dates are computed in the America/Los_Angeles timezone.
"""

from datetime import datetime, date

try:
    import pytz
    HAS_PYTZ = True
except ImportError:
    HAS_PYTZ = False
    import warnings
    warnings.warn("pytz not installed. Falling back to system local time. "
                  "For production use, install pytz: pip install pytz")


# Python's datetime.weekday() returns: Mon=0, Tue=1, Wed=2, Thu=3, Fri=4, Sat=5, Sun=6
# Our custom mapping:                  Mon=1, Tue=2, Wed=3, Thu=4, Fri=5, Sat=6, Sun=7
WEEKDAY_MAP = {
    0: 1,  # Monday    -> 1
    1: 2,  # Tuesday   -> 2
    2: 3,  # Wednesday -> 3
    3: 4,  # Thursday  -> 4
    4: 5,  # Friday    -> 5
    5: 6,  # Saturday  -> 6
    6: 7,  # Sunday    -> 7
}

# Legacy compatibility mapping retained for migration regression testing.
# Used by integrations built before policy v2.0 which followed Python's
# 0-indexed weekday() directly (Monday=0 through Sunday=6).
# DO NOT use _LEGACY_WEEKDAY_MAP for new password generation or verification.
_LEGACY_WEEKDAY_MAP = {
    0: 1,  # Monday    -> 1  (matches current)
    1: 2,  # Tuesday   -> 2  (matches current)
    2: 3,  # Wednesday -> 3  (matches current)
    3: 4,  # Thursday  -> 4  (matches current)
    4: 5,  # Friday    -> 5  (matches current)
    5: 6,  # Saturday  -> 6  (matches current)
    6: 0,  # Sunday    -> 0  (LEGACY / INCORRECT in current system: must be 7)
}

DEFAULT_TIMEZONE = "America/Los_Angeles"


def generate_daily_password(target_date=None, tz=DEFAULT_TIMEZONE):
    """
    Generate the daily password for a given date.

    Args:
        target_date: A datetime.date or datetime.datetime object.
                     If None, uses the current date in the specified timezone.
        tz: Timezone string (default: America/Los_Angeles).
            Only used when target_date is None.

    Returns:
        A 5-character string representing the daily password.
    """
    if target_date is None:
        if HAS_PYTZ:
            timezone = pytz.timezone(tz)
            now = datetime.now(timezone)
            target_date = now.date()
        else:
            target_date = date.today()

    if isinstance(target_date, datetime):
        target_date = target_date.date()

    # Extract MMDD (zero-padded)
    mmdd = target_date.strftime("%m%d")

    # Get weekday digit using custom mapping
    python_weekday = target_date.weekday()  # Mon=0 ... Sun=6
    weekday_digit = WEEKDAY_MAP[python_weekday]

    # Construct password
    password = f"{mmdd}{weekday_digit}"

    return password


def verify_password(user_input, target_date=None, tz=DEFAULT_TIMEZONE):
    """
    Verify a user-provided password against the expected daily password.

    Args:
        user_input: The password string provided by the user.
        target_date: Date to verify against (default: today in LA timezone).
        tz: Timezone string.

    Returns:
        True if the password matches, False otherwise.
    """
    expected = generate_daily_password(target_date=target_date, tz=tz)
    return str(user_input).strip() == expected


def get_password_components(target_date):
    """
    Return a dict with the password components for debugging/testing.

    Args:
        target_date: A date or datetime object.

    Returns:
        Dict with keys: date_iso, day_of_week_name, mmdd, weekday_digit, password
    """
    if isinstance(target_date, datetime):
        target_date = target_date.date()

    day_names = {
        0: "Monday", 1: "Tuesday", 2: "Wednesday", 3: "Thursday",
        4: "Friday", 5: "Saturday", 6: "Sunday"
    }

    python_weekday = target_date.weekday()
    mmdd = target_date.strftime("%m%d")
    weekday_digit = WEEKDAY_MAP[python_weekday]
    password = f"{mmdd}{weekday_digit}"

    return {
        "date_iso": target_date.isoformat(),
        "day_of_week_name": day_names[python_weekday],
        "mmdd": mmdd,
        "weekday_digit": weekday_digit,
        "password": password,
    }


if __name__ == "__main__":
    print("=" * 60)
    print("Daily Password Generator — Test Suite")
    print("=" * 60)

    # Test cases matching data/test_dates.csv
    test_cases = [
        (date(2025, 1, 1),   "Wednesday", "01013"),
        (date(2025, 2, 28),  "Friday",    "02285"),
        (date(2025, 3, 15),  "Saturday",  "03156"),
        (date(2025, 4, 20),  "Sunday",    "04207"),
        (date(2025, 5, 17),  "Saturday",  "05176"),
        (date(2025, 6, 1),   "Sunday",    "06017"),
        (date(2025, 7, 4),   "Friday",    "07045"),
        (date(2025, 8, 23),  "Saturday",  "08236"),
        (date(2025, 9, 9),   "Tuesday",   "09092"),
        (date(2025, 10, 13), "Monday",    "10131"),
        (date(2025, 11, 30), "Sunday",    "11307"),
        (date(2025, 12, 25), "Thursday",  "12254"),
    ]

    all_passed = True
    for test_date, expected_day, expected_password in test_cases:
        components = get_password_components(test_date)
        generated = generate_daily_password(target_date=test_date)
        verified = verify_password(expected_password, target_date=test_date)

        status = "PASS" if (generated == expected_password and verified) else "FAIL"
        if status == "FAIL":
            all_passed = False

        print(f"  [{status}] {test_date.isoformat()} ({expected_day:9s}) "
              f"-> MMDD={components['mmdd']} + WD={components['weekday_digit']} "
              f"= {generated} (expected: {expected_password})")

    print("-" * 60)
    if all_passed:
        print("All test cases PASSED.")
    else:
        print("Some test cases FAILED!")

    # Legacy vs current mapping comparison (identifies pre-v2.0 divergence points)
    print("\n" + "=" * 60)
    print("Legacy mapping comparison (migration regression check)")
    print("=" * 60)
    sunday_dates = [date(2025, 4, 20), date(2025, 6, 1), date(2025, 11, 30)]
    for d in sunday_dates:
        current_wd = WEEKDAY_MAP[d.weekday()]
        legacy_wd = _LEGACY_WEEKDAY_MAP[d.weekday()]
        current_pw = f"{d.strftime('%m%d')}{current_wd}"
        legacy_pw  = f"{d.strftime('%m%d')}{legacy_wd}"
        tag = "DIFFERS" if current_wd != legacy_wd else "SAME   "
        print(f"  [{tag}] {d.isoformat()} ({d.strftime('%A'):9s}) "
              f"current={current_pw}  legacy={legacy_pw}")

    # Show today's password
    print(f"\nToday's password: {generate_daily_password()}")
    today_components = get_password_components(date.today())
    print(f"  Date: {today_components['date_iso']}")
    print(f"  Day:  {today_components['day_of_week_name']}")
    print(f"  MMDD: {today_components['mmdd']}")
    print(f"  WD:   {today_components['weekday_digit']}")
