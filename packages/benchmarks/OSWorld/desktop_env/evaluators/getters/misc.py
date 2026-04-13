import logging
from typing import TypeVar, Dict
from datetime import datetime, timedelta
import pytz
import requests

logger = logging.getLogger("desktopenv.getters.misc")

R = TypeVar("Rule")

day_of_week_mapping = {
    0: 'Mon',
    1: 'Tue',
    2: 'Wed',
    3: 'Thu',
    4: 'Fri',
    5: 'Sat',
    6: 'Sun'
}

month_mapping = {
    1: 'Jan',
    2: 'Feb',
    3: 'Mar',
    4: 'Apr',
    5: 'May',
    6: 'Jun',
    7: 'Jul',
    8: 'Aug',
    9: 'Sep',
    10: 'Oct',
    11: 'Nov',
    12: 'Dec'
}

Month_Mapping_Full = {
    1: "January",
    2: "February",
    3: "March",
    4: "April",
    5: "May",
    6: "June",
    7: "July",
    8: "August",
    9: "September",
    10: "October",
    11: "November",
    12: "December"
}

month_mapping_full = {
    1: 'january',
    2: 'february',
    3:'march',
    4: 'april',
    5:'may',
    6: 'june',
    7: 'july',
    8: 'august',
    9:'september',
    10: 'october',
    11: 'november',
    12: 'december'
}

relativeTime_to_IntDay = {
    "tomorrow": 1,
    "5th next month": "special",
    "10th next month": "special",
    "11th next month": "special",
    "this month": "special",
    "this Saturday": "special",
    "this Sunday": "special",
    "next Monday": "special",
    "next Friday": "special",
    "next Saturday": "special",
    "next Sunday": "special",
    "next week Friday": "special",
    "next week Saturday": "special",
    "next week Sunday": "special",
    "first monday four months later": "special",
    "first monday eight months later": "special",
    "next Monday split": "special",
    "next Friday split": "special"
}

def get_rule(env, config: Dict[str, R]) -> R:
    """
    Returns the rule as-is.
    """
    return config["rules"]

def get_rule_relativeTime(env, config: Dict[str, R]) -> R:
    """
    According to the rule definded in funciton "apply_rules_to_timeFormat", convert the relative time to absolute time.
    config:
        'relativeTime': {
            "from": must exist; indicates the relativeTime.
            "to": optional; indicates the relativeTime.
        } 
        If relativeTime only has key "from", then the key of time in "expected" dict must be "time".
        If relativeTime has key "to", then the key of time in "expected" dict must be "from" and "to". 
        
        Optional 'timezone': timezone string like 'Europe/Zurich', 'America/New_York', etc.
        If not specified, will try to get timezone from IP geolocation.
    """
    logger.info(f"[DEBUG] get_rule_relativeTime called with config: {config}")
    
    relativeRules = config["rules"]
    relativeTime = relativeRules["relativeTime"] # int, "+" means future, "-" means past
    
    logger.info(f"[DEBUG] relativeTime: {relativeTime}")
    
    # Get timezone configuration
    timezone_str = get_timezone_from_config(config)
    try:
        timezone = pytz.timezone(timezone_str)
        logger.info(f"Successfully loaded timezone: {timezone_str}")
    except pytz.exceptions.UnknownTimeZoneError:
        logger.error(f"Unknown timezone: {timezone_str}, falling back to UTC")
        timezone = pytz.UTC
    
    # Get current time in the specified timezone
    now = datetime.now(timezone)
    logger.info(f"Current time in {timezone_str}: {now.strftime('%Y-%m-%d %H:%M:%S %Z')}")
    
    # calculate the relative time
    if "to" not in relativeTime.keys():
        start_relative_time = relativeTime["from"] 
        logger.info(f"Processing single time: '{start_relative_time}'")
        
        if relativeTime_to_IntDay[start_relative_time] != "special":
            # relativeTime can be represented by actual int days
            start_relative_time_IntDat = relativeTime_to_IntDay[start_relative_time]
            timediff = timedelta(days=start_relative_time_IntDat) 
            absoluteDay = now + timediff
            logger.info(f"Simple calculation: {start_relative_time} = {start_relative_time_IntDat} days → {absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
        else:
            # special case, you can add more special cases here
            if start_relative_time == "5th next month":
                next_year = now.year + 1 if now.month == 12 else now.year
                next_month = now.month + 1 if now.month < 12 else 1
                next_day = 5
                absoluteDay = timezone.localize(datetime(next_year, next_month, next_day))
                logger.info(f"5th next month: {absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            elif start_relative_time == "10th next month":
                next_year = now.year + 1 if now.month == 12 else now.year
                next_month = now.month + 1 if now.month < 12 else 1
                next_day = 10
                absoluteDay = timezone.localize(datetime(next_year, next_month, next_day))
                logger.info(f"10th next month: {absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            elif start_relative_time == "this month":
                absoluteDay = now
                logger.info(f"This month: {absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            elif start_relative_time == "next Monday":
                days_until_monday = (6-now.weekday()) + 1
                absoluteDay = now + timedelta(days=days_until_monday)
                logger.info(f"Next Monday: current weekday={now.weekday()}, days to add={days_until_monday} → {absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            elif start_relative_time == "first monday four months later":
                next_year = now.year + 1 if now.month >=9 else now.year
                next_month = (now.month + 4)%12
                # get the first monday of the next_month
                temp_date = timezone.localize(datetime(next_year, next_month, 1))
                days_to_monday = ((6-temp_date.weekday())+1)%7
                absoluteDay = temp_date + timedelta(days=days_to_monday)
                logger.info(f"First Monday 4 months later: {next_year}-{next_month:02d} → {absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            elif start_relative_time == "first monday eight months later":
                next_year = now.year + 1 if now.month >= 5 else now.year
                next_month = (now.month + 8)%12
                # get the first monday of the next_month
                temp_date = timezone.localize(datetime(next_year, next_month, 1))
                days_to_monday = ((6-temp_date.weekday())+1)%7
                absoluteDay = temp_date + timedelta(days=days_to_monday)
                logger.info(f"First Monday 8 months later: {next_year}-{next_month:02d} → {absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
        regular_time = apply_rules_to_timeFormat(relativeRules["expected"]["time"], absoluteDay)
        logger.info(f"Final formatted time: {regular_time}")
        config["rules"]["expected"]["time"] = regular_time

    else:
        from_time = relativeTime["from"]
        to_time = relativeTime["to"]
        logger.info(f"Processing time range: from '{from_time}' to '{to_time}'")
        
        # deal with from_time first
        if relativeTime_to_IntDay[from_time] != "special":
            from_time_IntDat = relativeTime_to_IntDay[from_time]
            from_timediff = timedelta(days=from_time_IntDat) 
            from_absoluteDay = now + from_timediff
            logger.info(f"From time calculation: {from_time} = {from_time_IntDat} days → {from_absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
        else:
            if from_time == "this Saturday":
                days_until_saturday = (5-now.weekday())
                from_absoluteDay = now + timedelta(days=days_until_saturday)
                logger.info(f"This Saturday: current weekday={now.weekday()}, days to add={days_until_saturday} → {from_absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            elif from_time == "10th next month":
                next_year = now.year + 1 if now.month == 12 else now.year
                next_month = now.month + 1 if now.month < 12 else 1
                next_day = 10
                from_absoluteDay = timezone.localize(datetime(next_year, next_month, next_day))
                logger.info(f"10th next month (from): {from_absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            elif from_time == "next Monday" or from_time == "next Monday split":
               days_until_monday = (6-now.weekday()) + 1
               from_absoluteDay = now + timedelta(days=days_until_monday) 
               logger.info(f"Next Monday (from): current weekday={now.weekday()}, days to add={days_until_monday} → {from_absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            elif from_time == "next Friday":
                # Next weekend Friday calculation
                if now.weekday() < 4:  # Monday to Thursday - use this weekend
                    days_until_friday = 4 - now.weekday()
                elif now.weekday() == 4:  # Today is Friday - use next weekend
                    days_until_friday = 7
                else:  # Saturday to Sunday - use next weekend
                    days_until_friday = (7 - now.weekday()) + 4  # Days to next Monday + 4 to get to Friday
                from_absoluteDay = now + timedelta(days=days_until_friday)
                logger.info(f"Next Friday (from): current weekday={now.weekday()}, days to add={days_until_friday} → {from_absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            elif from_time == "next Saturday":
                # Next weekend Saturday calculation
                if now.weekday() < 5:  # Monday to Friday - use this weekend
                    days_until_saturday = 5 - now.weekday()
                elif now.weekday() == 5:  # Today is Saturday - use next weekend
                    days_until_saturday = 7
                else:  # Sunday - use next weekend
                    days_until_saturday = 6  # 6 days to next Saturday
                from_absoluteDay = now + timedelta(days=days_until_saturday)
                logger.info(f"Next Saturday (from): current weekday={now.weekday()}, days to add={days_until_saturday} → {from_absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            elif from_time == "next week Friday":
                # Next week Friday - simple: go to next Monday, then +4 days
                days_to_next_monday = 7 - now.weekday()
                days_until_friday = days_to_next_monday + 4  # Monday + 4 = Friday
                from_absoluteDay = now + timedelta(days=days_until_friday)
                logger.info(f"Next week Friday (from): current weekday={now.weekday()}, days to add={days_until_friday} → {from_absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            elif from_time == "next week Saturday":
                # Next week Saturday - simple: go to next Monday, then +5 days
                days_to_next_monday = 7 - now.weekday()
                days_until_saturday = days_to_next_monday + 5  # Monday + 5 = Saturday
                from_absoluteDay = now + timedelta(days=days_until_saturday)
                logger.info(f"Next week Saturday (from): current weekday={now.weekday()}, days to add={days_until_saturday} → {from_absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            elif from_time == "next week Sunday":
                # Next week Sunday - simple: go to next Monday, then +6 days
                days_to_next_monday = 7 - now.weekday()
                days_until_sunday = days_to_next_monday + 6  # Monday + 6 = Sunday
                from_absoluteDay = now + timedelta(days=days_until_sunday)
                logger.info(f"Next week Sunday (from): current weekday={now.weekday()}, days to add={days_until_sunday} → {from_absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            else:
                pass # more rules here
        if from_time == "next Monday split":
            puday = apply_rules_to_timeFormat(relativeRules["expected"]["puDay"], from_absoluteDay)
            config["rules"]["expected"]["puDay"] = puday
            pumonth = apply_rules_to_timeFormat(relativeRules["expected"]["puMonth"], from_absoluteDay)
            config["rules"]["expected"]["puMonth"] = pumonth
            puyear = apply_rules_to_timeFormat(relativeRules["expected"]["puYear"], from_absoluteDay)
            config["rules"]["expected"]["puYear"] = puyear
            logger.info(f"Monday split formatting: puDay={puday}, puMonth={pumonth}, puYear={puyear}")
        else:
            regular_from_time = apply_rules_to_timeFormat(relativeRules["expected"]["from"], from_absoluteDay)
            config["rules"]["expected"]["from"] = regular_from_time
            logger.info(f"From time formatted: {regular_from_time}")

        # deal with to_time
        if relativeTime_to_IntDay[to_time] != "special":
            to_time_IntDat = relativeTime_to_IntDay[to_time]
            to_timediff = timedelta(days=to_time_IntDat) 
            to_absoluteDay = now + to_timediff
            logger.info(f"To time calculation: {to_time} = {to_time_IntDat} days → {to_absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
        else:
            if to_time == "this Sunday":
                days_until_sunday = (6-now.weekday())
                to_absoluteDay = now + timedelta(days=days_until_sunday)
                logger.info(f"This Sunday: current weekday={now.weekday()}, days to add={days_until_sunday} → {to_absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            elif to_time == "11th next month":
                next_year = now.year + 1 if now.month == 12 else now.year
                next_month = now.month + 1 if now.month < 12 else 1
                next_day = 11
                to_absoluteDay = timezone.localize(datetime(next_year, next_month, next_day))
                logger.info(f"11th next month (to): {to_absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            elif to_time == "next Friday" or to_time == "next Friday split":
                # Check if from_time is any variant of "next Monday"
                if from_time in ["next Monday", "next Monday split"]:
                    # Calculate Friday of the same week as the Monday
                    # from_absoluteDay is already calculated as next Monday
                    # Friday is 4 days after Monday (Monday=0, Friday=4)
                    to_absoluteDay = from_absoluteDay + timedelta(days=4)
                    logger.info(f"Next Friday (same week as Monday): from Monday {from_absoluteDay.strftime('%Y-%m-%d')} + 4 days → {to_absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
                else:
                    # Standalone "next Friday" calculation
                    if now.weekday() < 4:  # Monday to Thursday
                        days_to_friday = 4 - now.weekday()
                    else:  # Friday to Sunday
                        days_to_friday = (6 - now.weekday()) + 5
                    to_absoluteDay = now + timedelta(days=days_to_friday)
                    logger.info(f"Next Friday (standalone): current weekday={now.weekday()}, days to add={days_to_friday} → {to_absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            elif to_time == "next Sunday":
                # Next weekend Sunday calculation - should be the same weekend as the from_time
                if from_time in ["next Friday", "next Saturday"]:
                    # Calculate Sunday of the same weekend as from_time
                    # from_absoluteDay is already calculated, get the Sunday of that week
                    days_to_add_for_sunday = 6 - from_absoluteDay.weekday()  # Days from Friday/Saturday to Sunday
                    to_absoluteDay = from_absoluteDay + timedelta(days=days_to_add_for_sunday)
                    logger.info(f"Next Sunday (to, same weekend as {from_time}): from {from_absoluteDay.strftime('%Y-%m-%d %A')} + {days_to_add_for_sunday} days → {to_absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
                else:
                    # Standalone next Sunday calculation
                    if now.weekday() < 6:  # Monday to Saturday - use this weekend
                        days_until_sunday = 6 - now.weekday()
                    else:  # Sunday - use next weekend
                        days_until_sunday = 7
                    to_absoluteDay = now + timedelta(days=days_until_sunday)
                    logger.info(f"Next Sunday (to, standalone): current weekday={now.weekday()}, days to add={days_until_sunday} → {to_absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            elif to_time == "next week Sunday":
                # Next week Sunday calculation - should be the same week as from_time if from_time is also "next week"
                if from_time in ["next week Friday", "next week Saturday"]:
                    # Calculate Sunday of the same week as from_time
                    # from_absoluteDay is already calculated, get the Sunday of that week
                    days_to_add_for_sunday = 6 - from_absoluteDay.weekday()  # Days from Friday/Saturday to Sunday
                    to_absoluteDay = from_absoluteDay + timedelta(days=days_to_add_for_sunday)
                    logger.info(f"Next week Sunday (to, same week as {from_time}): from {from_absoluteDay.strftime('%Y-%m-%d %A')} + {days_to_add_for_sunday} days → {to_absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
                else:
                    # Standalone next week Sunday calculation - simple: go to next Monday, then +6 days
                    days_to_next_monday = 7 - now.weekday()
                    days_until_sunday = days_to_next_monday + 6  # Monday + 6 = Sunday
                    to_absoluteDay = now + timedelta(days=days_until_sunday)
                    logger.info(f"Next week Sunday (to, standalone): current weekday={now.weekday()}, days to add={days_until_sunday} → {to_absoluteDay.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            else:
                pass # more rules here
        if to_time == "next Friday split":
            to_day = apply_rules_to_timeFormat(relativeRules["expected"]["doDay"], to_absoluteDay)
            config["rules"]["expected"]["doDay"] = to_day
            to_month = apply_rules_to_timeFormat(relativeRules["expected"]["doMonth"], to_absoluteDay)
            config["rules"]["expected"]["doMonth"] = to_month
            to_year = apply_rules_to_timeFormat(relativeRules["expected"]["doYear"], to_absoluteDay)
            config["rules"]["expected"]["doYear"] = to_year
            logger.info(f"Friday split formatting: doDay={to_day}, doMonth={to_month}, doYear={to_year}")
        else:
            regular_to_time = apply_rules_to_timeFormat(relativeRules["expected"]["to"], to_absoluteDay)
            config["rules"]["expected"]["to"] = regular_to_time
            logger.info(f"To time formatted: {regular_to_time}")
    
    logger.info(f"[DEBUG] Final config rules: {config['rules']}")
    print(config["rules"])
    return config["rules"]


def apply_rules_to_timeFormat(timeFormat: str, absoluteDay: datetime):
    timeFormat = timeFormat.replace("{DoW}", day_of_week_mapping[absoluteDay.weekday()], 1)
    timeFormat = timeFormat.replace("{Month}", month_mapping[absoluteDay.month], 1)
    timeFormat = timeFormat.replace("{DayD}", str(absoluteDay.day), 1)
    timeFormat = timeFormat.replace("{Year}", str(absoluteDay.year), 1)
    timeFormat = timeFormat.replace("{Month0D}", "0"+str(absoluteDay.month) if absoluteDay.month < 10 else str(absoluteDay.month), 1)
    timeFormat = timeFormat.replace("{month}", month_mapping_full[absoluteDay.month], 1)
    timeFormat = timeFormat.replace("{MonthFull}", Month_Mapping_Full[absoluteDay.month], 1)
    timeFormat = timeFormat.replace("{Day0D}", "0"+str(absoluteDay.day) if absoluteDay.day < 10 else str(absoluteDay.day), 1)
    timeFormat = timeFormat.replace("{MonthD}", str(absoluteDay.month), 1)
    # you can add other replace rules here

    return timeFormat


def get_accessibility_tree(env, *args) -> str:
    accessibility_tree: str = env.controller.get_accessibility_tree()
    logger.debug("AT@eval: %s", accessibility_tree)
    return accessibility_tree

def get_time_diff_range(env, config) -> str:
    try:
        return config["diff_range_in_minutes"]
    except:
        logger.error("diff_range_in_minutes not found in config.")
        return None

def get_timezone_from_ip() -> str:
    """
    Get timezone from IP address using IP geolocation API
    Returns timezone string like 'Europe/Zurich' or 'UTC' as fallback
    """
    try:
        # Try ipapi.co first
        response = requests.get('https://ipapi.co/json/', timeout=5)
        if response.status_code == 200:
            data = response.json()
            timezone = data.get('timezone')
            if timezone:
                logger.info(f"Timezone from IP: {timezone}")
                return timezone
    except Exception as e:
        logger.warning(f"Failed to get timezone from IP: {e}")
    
    # Fallback to UTC
    logger.info("Using UTC as fallback timezone")
    return 'UTC'

def get_timezone_from_config(config: Dict, default_timezone: str = None) -> str:
    """
    Get timezone from config, with fallback options
    Priority: config timezone > default_timezone > IP-based timezone > UTC
    """
    # Check if timezone is specified in config
    if "timezone" in config.get("rules", {}):
        timezone = config["rules"]["timezone"]
        logger.info(f"Using timezone from config: {timezone}")
        return timezone
    
    # Use provided default
    if default_timezone:
        logger.info(f"Using provided default timezone: {default_timezone}")
        return default_timezone
    
    # Get from IP
    return get_timezone_from_ip()