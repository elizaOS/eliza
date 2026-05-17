from argparse import ArgumentParser
import os
import sys
import re
from pathlib import Path
from datetime import datetime, timedelta, timezone
import json



from mcp_convert.mcps.calendar.database_utils import CalendarDatabase


def parse_iso_time(iso_string):
    """
    Parse various ISO time string formats, always return timezone-aware datetime
    """
    # Handle different ISO formats
    if iso_string.endswith('Z'):
        # UTC time
        iso_string = iso_string[:-1] + '+00:00'
    
    try:
        # Python 3.7+ method
        dt = datetime.fromisoformat(iso_string)
        # If naive datetime, add UTC timezone
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except:
        # Fallback: use dateutil
        try:
            import dateutil.parser
            dt = dateutil.parser.isoparse(iso_string)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except:
            # Last fallback: return current time
            return datetime.now(timezone.utc)


def compare_google_calendar_times(pred_google_time, groundtruth_iso_time, tolerance_seconds=300):
    """
    Compare Google Calendar API returned times
    Google Calendar may return dateTime or date format

    For events without timezone, assume AoE (Anywhere on Earth, UTC-12) timezone,
    to match deadline timezone used in groundtruth.
    """
    # AoE timezone (UTC-12)
    AOE_TIMEZONE = timezone(timedelta(hours=-12))

    def parse_google_time(time_dict, default_tz=None):
        if 'dateTime' in time_dict:
            dt_str = time_dict['dateTime']
            try:
                dt = datetime.fromisoformat(dt_str)
                # If naive datetime, use specified default timezone
                if dt.tzinfo is None and default_tz is not None:
                    dt = dt.replace(tzinfo=default_tz)
                elif dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt
            except:
                return parse_iso_time(dt_str)
        elif 'date' in time_dict:
        # All-day event, only date - use default timezone
            dt = datetime.strptime(time_dict['date'], '%Y-%m-%d')
            if default_tz is not None:
                return dt.replace(tzinfo=default_tz)
            return dt.replace(tzinfo=timezone.utc)
        else:
            raise ValueError("Invalid time format")

    # Check if event time has timezone information
    event_dt_str = pred_google_time.get('dateTime', '')
    has_timezone = '+' in event_dt_str or '-' in event_dt_str[10:] or event_dt_str.endswith('Z')

    # If event has no timezone, assume AoE timezone (consistent with groundtruth)
    if not has_timezone:
        print(f"   ℹ️  Event has no timezone info, assuming AoE (UTC-12)")
        parsed_time1 = parse_google_time(pred_google_time, default_tz=AOE_TIMEZONE)
    else:
        parsed_time1 = parse_google_time(pred_google_time)

    parsed_time2 = parse_iso_time(groundtruth_iso_time)

    diff = abs((parsed_time1 - parsed_time2).total_seconds())
    print(f"Time difference: {diff} sec = {diff/60} min = {diff/3600} hours")

    return diff <= tolerance_seconds


def main(args):
    """Main evaluation function"""
    print("\n" + "=" * 60)
    print("🔍 Conference Reminder Task Evaluation")
    print("=" * 60)
    
    # Determine Calendar database directory
    if args.task_root:
        # If task root is specified, use local_db/calendar under task root
        calendar_db_dir = str(Path(args.task_root) / "local_db" / "calendar")
    elif args.agent_workspace:
        workspace_parent = Path(args.agent_workspace).parent
        calendar_db_dir = str(workspace_parent / "local_db" / "calendar")
    else:
        calendar_db_dir = str(Path(__file__).parent.parent / "local_db" / "calendar")
    
    print(f"📂 Calendar database directory: {calendar_db_dir}")
    
    if not Path(calendar_db_dir).exists():
        print(f"❌ Calendar database directory doesn't exist: {calendar_db_dir}")
        exit(1)
    
    # Set environment variable
    os.environ['CALENDAR_DATA_DIR'] = calendar_db_dir
    
    # Initialize CalendarDatabase
    calendar_db = CalendarDatabase(data_dir=calendar_db_dir)
    
    # Read groundtruth metadata (get target conferences and deadlines)
    if args.task_root:
        # If task root is specified, use groundtruth_workspace under task root
        groundtruth_dir = Path(args.task_root) / "groundtruth_workspace"
    else:
        # Fallback to script relative path
        groundtruth_dir = Path(__file__).parent.parent / "groundtruth_workspace"
    metadata_file = groundtruth_dir / "conference_metadata.json"
    
    # Store all validation targets
    validation_targets = []
    
    if metadata_file.exists():
        with open(metadata_file, 'r', encoding='utf-8') as f:
            metadata = json.load(f)
        
        target_info = metadata.get('target_info', {})
        target_conferences = target_info.get('conferences', [])
        
        print(f"\n📊 Groundtruth information:")
        print(f"   Target conferences: {target_info.get('count', len(target_conferences))}")
        
        # Generate validation target for each target conference
        for conf_info in target_conferences:
            conf_key = conf_info['conference']
            deadline_str = conf_info['deadline']
            track = conf_info['track']
            full_name = conf_info.get('full_name', '')
            
            # Calculate reminder time (deadline - 3 hours)
            deadline_dt = parse_iso_time(deadline_str)
            reminder_dt = deadline_dt - timedelta(hours=3)
            
            # Generate keywords
            keywords = [conf_key.lower(), 'camera', 'ready']
            
            validation_targets.append({
                'conference': conf_key,
                'full_name': full_name,
                'track': track,
                'deadline': deadline_str,
                'reminder_time': reminder_dt.isoformat(),
                'reminder_date': reminder_dt.date(),
                'keywords': keywords
            })
            
            print(f"   • {conf_key} ({track}):")
            print(f"      Deadline: {deadline_str}")
            print(f"      Reminder time: {reminder_dt.isoformat()}")
    else:
        # Backward compatibility: use default configuration
        print("⚠️  Metadata file not found, using default config (COML)")
        today_file_path = groundtruth_dir / "today.txt"
        if not today_file_path.exists():
            print(f"❌ today.txt file doesn't exist: {today_file_path}")
            exit(1)
        
        with open(today_file_path, 'r', encoding='utf-8') as f:
            today = f.read().strip()
        
        target_date = (datetime.strptime(today, '%Y-%m-%d') + timedelta(days=11)).date()
        gt_time = f"{target_date}T20:59:00-12:00"
        
        validation_targets.append({
            'conference': 'COML',
            'track': 'main-track',
            'deadline': None,
            'reminder_time': gt_time,
            'reminder_date': target_date,
            'keywords': ['coml', 'camera', 'ready']
        })
    
    # Query all possible reminder date ranges
    # Find all target dates
    all_target_dates = set([target['reminder_date'] for target in validation_targets])

    # Get date range
    min_date = min(all_target_dates)
    max_date = max(all_target_dates)
    
    print(f"\n📅 Search date range: {min_date} to {max_date}")
    
    try:
        # Use CalendarDatabase to query events
        all_events = calendar_db.list_events(
            time_min=f"{min_date}T00:00:00-12:00",
            time_max=f"{max_date}T23:59:59-12:00",
            order_by="startTime"
        )
    except Exception as e:
        print(f"❌ Detection error occurred: {e}")
        import traceback
        traceback.print_exc()
        exit(2)
    
    print(f"\n📋 Found {len(all_events)} Calendar events")
    
    # Validate each target conference
    validation_results = []
    
    for target in validation_targets:
        conf_key = target['conference']
        full_name = target.get('full_name', '')
        keywords = target['keywords']
        gt_time = target['reminder_time']
        
        print(f"\n{'='*60}")
        print(f"🔍 Verifying event: {conf_key}")
        if full_name:
            print(f"   Full name: {full_name}")
        keywords_str = ', '.join([f"'{k}'" for k in keywords])
        print(f"   Keywords: {keywords_str}")
        print(f"   Target time: {gt_time}")
        print("=" * 60)
        
        found = False
        
        for event in all_events:
            summary = event.get('summary', '')
            start_time = event.get('start', {})
            summary_lower = summary.lower()
            
            # Check if event title contains conference name (conf_key or full_name) and other keywords
            # Conference name: either conf_key or full_name (using word boundary matching to avoid "ca" matching "camera")
            # Other keywords: all must be present
            def match_word(word, text):
                """Use word boundary matching to avoid substring mismatches"""
                pattern = r'\b' + re.escape(word.lower()) + r'\b'
                return bool(re.search(pattern, text.lower()))

            has_conf_name = match_word(conf_key, summary) or (match_word(full_name, summary) if full_name else False)
            other_keywords = [kw for kw in keywords if kw != conf_key.lower()]
            has_other_keywords = all(kw in summary_lower for kw in other_keywords)
            
            if has_conf_name and has_other_keywords:
                print(f"\n📌 Found matching event: {summary}")
                print(f"   Start time: {start_time}")
                print(f"   🕐 Compare time: {start_time} vs {gt_time}")

                if compare_google_calendar_times(start_time, gt_time, 300):
                    found = True
                    print(f"   ✅ Time meets requirements (5 minute tolerance)")
                    break
                else:
                    print(f"   ❌ Time doesn't meet requirements")
        
        validation_results.append({
            'conference': conf_key,
            'found': found
        })
        
        if found:
            print(f"✅ {conf_key} verification passed")
        else:
            print(f"❌ {conf_key} verification failed")
    
    # Summary results
    print("\n" + "=" * 60)
    print("📊 Validation result summary")
    print("=" * 60)
    
    all_passed = True
    for result in validation_results:
        status = "✅" if result['found'] else "❌"
        print(f"{status} {result['conference']}")
        if not result['found']:
            all_passed = False
    
    print("\n" + "=" * 60)
    
    if not all_passed:
        print("💥 Evaluation failed! Some conference reminders not created")
        print("=" * 60)
        print("📝 Checklist:")
        for target in validation_targets:
            result = next((r for r in validation_results if r['conference'] == target['conference']), None)
            if result and not result['found']:
                conf_key = target['conference']
                full_name = target.get('full_name', '')
                other_keywords = [kw for kw in target['keywords'] if kw != conf_key.lower()]
                other_keywords_str = ', '.join(other_keywords)
                print(f"\n❌ {conf_key}:")
                print(f"   • Does the event title contain conference name ('{conf_key}' or '{full_name}')?")
                print(f"   • Does the event title contain other keywords: {other_keywords_str}?")
                print(f"   • Is the event time {target['reminder_time']}?")
                print(f"   • Was the event created on the correct date ({target['reminder_date']})?")
        exit(1)
    
    print("🎉 Evaluation passed!")
    print("=" * 60)
    print(f"✅ All {len(validation_targets)} target conference reminders were created correctly")
    for target in validation_targets:
        print(f"   • {target['conference']} ({target['track']})")
    exit(0)


if __name__=="__main__":
    parser = ArgumentParser(description="Conference reminder task evaluation script")
    parser.add_argument("--agent_workspace", required=False, help="Agent workspace path")
    parser.add_argument("--groundtruth_workspace", required=False, help="Groundtruth workspace path")
    parser.add_argument("--task-root", required=False, help="Task root directory")
    parser.add_argument("--res_log_file", required=False, help="Result log file path")
    parser.add_argument("--launch_time", required=False, help="Launch time")
    args = parser.parse_args()

    main(args)
