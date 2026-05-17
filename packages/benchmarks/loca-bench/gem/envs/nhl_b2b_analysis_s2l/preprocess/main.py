#!/usr/bin/env python3
"""
Main preprocess script for nhl-b2b-analysis task (Local Database Version).
This script generates NHL schedule data and initializes Google Sheets.
"""

import sys
import os
import csv
import json
import shutil
import random
from pathlib import Path
from argparse import ArgumentParser
from datetime import datetime, timedelta

# Add current task directory to path
current_dir = os.path.dirname(os.path.abspath(__file__))
task_dir = os.path.dirname(current_dir)
sys.path.insert(0, task_dir)

from mcp_convert.mcps.google_sheet.database_utils import GoogleSheetDatabase
from gem.utils.filesystem import nfs_safe_rmtree


def generate_nhl_schedule_data(num_games: int = 100, 
                                num_teams: int = 32,
                                start_date: str = "2024-10-01",
                                seed: int = 42) -> list:
    """
    Generate NHL 2024-25 season schedule data
    
    Follows NHL 2024-25 season characteristics:
    - Season starts: October 2024
    - Season ends: April 2025 (regular season)
    - Each team plays 82 games in a full season
    - Games distributed realistically across season
    - Back-to-back games occur but not excessively
    
    Args:
        num_games: Number of games to generate
        num_teams: Number of teams (can be any positive integer)
        start_date: Season start date (default: 2024-10-01 for NHL 2024-25)
        seed: Random seed for reproducibility
        
    Returns:
        List of lists containing game data (including header)
    """
    random.seed(seed)
    
    # Real 32 NHL teams (2024-25 season)
    real_nhl_teams = [
        "Anaheim Ducks", "Utah Hockey Club", "Boston Bruins", "Buffalo Sabres",
        "Calgary Flames", "Carolina Hurricanes", "Chicago Blackhawks", "Colorado Avalanche",
        "Columbus Blue Jackets", "Dallas Stars", "Detroit Red Wings", "Edmonton Oilers",
        "Florida Panthers", "Los Angeles Kings", "Minnesota Wild", "Montreal Canadiens",
        "Nashville Predators", "New Jersey Devils", "New York Islanders", "New York Rangers",
        "Ottawa Senators", "Philadelphia Flyers", "Pittsburgh Penguins", "San Jose Sharks",
        "Seattle Kraken", "St. Louis Blues", "Tampa Bay Lightning", "Toronto Maple Leafs",
        "Vancouver Canucks", "Vegas Golden Knights", "Washington Capitals", "Winnipeg Jets"
    ]
    
    # Generate team list
    teams = []
    
    if num_teams <= 32:
        # Use real NHL teams
        teams = real_nhl_teams[:num_teams]
    else:
        # Use all real NHL teams plus generated virtual teams
        teams = real_nhl_teams.copy()
        
        # Generate additional virtual teams
        team_name_prefixes = [
            "Atlantic", "Pacific", "Central", "Metro", "Northern", "Southern",
            "Eastern", "Western", "Midwest", "Northeast", "Northwest", "Southeast",
            "Southwest", "Mountain", "Coastal", "Valley", "Plains", "Desert",
            "Arctic", "Tropical", "Highland", "Lowland", "River", "Lake",
            "Ocean", "Bay", "Gulf", "Harbor", "Island", "Peninsula"
        ]
        
        team_name_suffixes = [
            "Bears", "Wolves", "Eagles", "Hawks", "Lions", "Tigers", "Panthers",
            "Jaguars", "Leopards", "Cougars", "Bobcats", "Lynx", "Foxes",
            "Ravens", "Falcons", "Condors", "Owls", "Sharks", "Whales",
            "Dolphins", "Orcas", "Barracudas", "Marlins", "Swordfish",
            "Dragons", "Phoenix", "Griffins", "Thunder", "Lightning", "Storm",
            "Blizzard", "Avalanche", "Cyclones", "Hurricanes", "Tornados",
            "Comets", "Meteors", "Stars", "Cosmos", "Nebulas", "Galaxies",
            "Warriors", "Knights", "Titans", "Giants", "Gladiators", "Spartans",
            "Vikings", "Crusaders", "Centurions", "Trojans", "Renegades"
        ]
        
        # Generate virtual team names
        virtual_team_count = num_teams - 32
        for i in range(virtual_team_count):
            prefix = team_name_prefixes[i % len(team_name_prefixes)]
            suffix = team_name_suffixes[i % len(team_name_suffixes)]
            
            # Add number if we've cycled through combinations
            cycle = i // (len(team_name_prefixes) * len(team_name_suffixes))
            if cycle > 0:
                team_name = f"{prefix} {suffix} {cycle + 1}"
            else:
                team_name = f"{prefix} {suffix}"
            
            teams.append(team_name)
    
    # Game statuses and their probabilities
    statuses = ["Regulation", "OT", "SO"]
    status_weights = [0.75, 0.20, 0.05]  # Most games end in regulation
    
    # Start times (Saskatchewan time) and their ET equivalents
    start_times = [
        ("11:00:00", "13:00:00"),
        ("14:30:00", "16:30:00"),
        ("17:00:00", "19:00:00"),
        ("17:30:00", "19:30:00"),
        ("18:00:00", "20:00:00"),
        ("18:30:00", "20:30:00"),
        ("19:00:00", "21:00:00"),
        ("20:00:00", "22:00:00"),
        ("20:30:00", "22:30:00"),
    ]
    
    # Generate header
    data = [["Date", "Start Time (Sask)", "Start Time (ET)", "Visitor", "Score", "Home", "Score.1", "Status"]]
    
    # Parse start date
    current_date = datetime.strptime(start_date, "%Y-%m-%d")
    
    # Generate games with NHL 2024-25 season characteristics
    games_generated = 0
    day_offset = 0
    
    # Track team schedules to ensure realistic distribution
    team_last_game_day = {team: -10 for team in teams}  # Last day each team played
    team_game_counts = {team: 0 for team in teams}
    
    # Calculate season length based on game count
    # NHL regular season: ~185 days (Oct-Apr), each team plays 82 games
    if num_teams <= 32:
        # For real NHL teams, estimate season days
        season_days = max(60, int(num_games * 0.4))  # Realistic spread
    else:
        # For larger leagues, adjust accordingly
        season_days = max(90, int(num_games * 0.3))
    
    while games_generated < num_games:
        # Date for this batch of games
        game_date = current_date + timedelta(days=day_offset)
        date_str = game_date.strftime("%Y-%m-%d")
        
        # NHL realistic games per day distribution
        # - Most days: 2-8 games (weekdays)
        # - Busy days: 10-15 games (weekends)
        # - Some days: 0 games (breaks)
        day_of_week = game_date.weekday()  # 0=Monday, 6=Sunday
        
        # Calculate maximum possible games per day (limited by team count)
        max_possible_games = num_teams // 2
        
        if day_of_week in [5, 6]:  # Weekend
            # Weekend: try 5-12 games, but respect team count limits
            min_games = min(5, max_possible_games)
            max_games = min(12, max_possible_games)
            max_games_today = random.randint(min_games, max(min_games, max_games))
        else:  # Weekday
            # Weekday: try 2-8 games, but respect team count limits
            min_games = min(2, max_possible_games)
            max_games = min(8, max_possible_games)
            max_games_today = random.randint(min_games, max(min_games, max_games))
        
        # Occasionally have no games (season breaks)
        if random.random() < 0.05:  # 5% chance of no games
            day_offset += 1
            continue
        
        games_today = min(max_games_today, num_games - games_generated)
        
        # Track teams playing today to avoid back-to-back on same day
        teams_playing_today = set()
        
        for _ in range(games_today):
            # Select teams that haven't played too recently
            # NHL teams typically have 1-2 days rest between games
            # Back-to-back happens but is not common (~15-20 per team per season)
            
            # First try: teams with normal rest (2+ days)
            available_teams = []
            b2b_candidates = []  # Teams that could play back-to-back
            
            for t in teams:
                if t not in teams_playing_today:
                    days_since_last = day_offset - team_last_game_day[t]
                    if days_since_last >= 2:  # Normal rest
                        available_teams.append(t)
                    elif days_since_last == 1:  # Potential back-to-back
                        b2b_candidates.append(t)
            
            # If not enough teams with normal rest, carefully add back-to-back candidates
            if len(available_teams) < 2 and b2b_candidates:
                # Only allow back-to-backs if absolutely needed or with low probability
                needed = max(0, 2 - len(available_teams))
                random.shuffle(b2b_candidates)
                
                for candidate in b2b_candidates[:needed]:
                    if random.random() < 0.2:  # 20% chance to allow B2B when needed
                        available_teams.append(candidate)
            
            # Last resort: if still not enough teams, allow any available team
            if len(available_teams) < 2:
                available_teams = [t for t in teams if t not in teams_playing_today]
            
            if len(available_teams) < 2:
                break  # Not enough teams available today
            
            visitor = random.choice(available_teams)
            teams_playing_today.add(visitor)
            team_last_game_day[visitor] = day_offset
            team_game_counts[visitor] += 1
            
            available_teams = [t for t in available_teams if t != visitor]
            home = random.choice(available_teams)
            teams_playing_today.add(home)
            team_last_game_day[home] = day_offset
            team_game_counts[home] += 1
            
            # Random start time
            start_sask, start_et = random.choice(start_times)
            
            # Random scores (0-8 goals per team, weighted towards lower scores)
            visitor_score = random.choices(range(9), weights=[5, 10, 15, 15, 12, 8, 5, 3, 2])[0]
            home_score = random.choices(range(9), weights=[5, 10, 15, 15, 12, 8, 5, 3, 2])[0]
            
            # Determine status and adjust scores if needed
            status = random.choices(statuses, weights=status_weights)[0]
            
            if status == "Regulation":
                # Make sure scores are different
                if visitor_score == home_score:
                    if random.random() < 0.5:
                        visitor_score += 1
                    else:
                        home_score += 1
            else:  # OT or SO
                # Winning team gets one more goal
                if random.random() < 0.5:
                    visitor_score = home_score + 1
                else:
                    home_score = visitor_score + 1
            
            # Add game to data
            data.append([
                date_str,
                start_sask,
                start_et,
                visitor,
                str(visitor_score),
                home,
                str(home_score),
                status
            ])
            
            games_generated += 1
            
            if games_generated >= num_games:
                break
        
        # Move to next day
        day_offset += 1
        
        # Safety check to prevent infinite loop
        # Ensure we don't exceed reasonable season length
        if day_offset > season_days * 1.5:
            print(f"   ⚠️  Warning: Reached day {day_offset}, generated {games_generated}/{num_games} games")
            break
    
    return data


def calculate_back_to_back_analysis(csv_data: list) -> dict:
    """
    Calculate back-to-back game analysis for all teams
    
    Args:
        csv_data: List of lists containing game data (with header)
        
    Returns:
        Dictionary mapping team names to their back-to-back statistics
    """
    if not csv_data or len(csv_data) < 2:
        return {}
    
    # Skip header row
    games = csv_data[1:]
    
    # Build a dictionary of team schedules: {team: [(date, is_home), ...]}
    team_schedules = {}
    
    for game in games:
        if len(game) < 6:
            continue
        
        date = game[0]  # Date
        visitor = game[3]  # Visitor (away team)
        home = game[5]  # Home team
        
        # Add to visitor's schedule (away game)
        if visitor not in team_schedules:
            team_schedules[visitor] = []
        team_schedules[visitor].append((date, False))  # False = away
        
        # Add to home's schedule (home game)
        if home not in team_schedules:
            team_schedules[home] = []
        team_schedules[home].append((date, True))  # True = home
    
    # Sort each team's schedule by date
    for team in team_schedules:
        team_schedules[team].sort(key=lambda x: x[0])
    
    # Calculate back-to-back situations for each team
    b2b_stats = {}
    
    for team, schedule in team_schedules.items():
        ha = 0  # Home-Away
        ah = 0  # Away-Home
        hh = 0  # Home-Home
        aa = 0  # Away-Away
        
        for i in range(len(schedule) - 1):
            date1, is_home1 = schedule[i]
            date2, is_home2 = schedule[i + 1]
            
            # Check if games are on consecutive days
            try:
                d1 = datetime.strptime(date1, "%Y-%m-%d")
                d2 = datetime.strptime(date2, "%Y-%m-%d")
                days_apart = (d2 - d1).days
                
                # Back-to-back means exactly 1 day apart
                if days_apart == 1:
                    if is_home1 and not is_home2:
                        ha += 1
                    elif not is_home1 and is_home2:
                        ah += 1
                    elif is_home1 and is_home2:
                        hh += 1
                    elif not is_home1 and not is_home2:
                        aa += 1
            except ValueError:
                continue
        
        total = ha + ah + hh + aa
        b2b_stats[team] = {
            'HA': ha,
            'AH': ah,
            'HH': hh,
            'AA': aa,
            'Total': total
        }
    
    return b2b_stats


def save_standard_answer(b2b_stats: dict, output_file: Path) -> bool:
    """
    Save back-to-back analysis to CSV file in standard format
    
    Args:
        b2b_stats: Dictionary of back-to-back statistics
        output_file: Output CSV file path
        
    Returns:
        True if save succeeded
    """
    try:
        # Create output directory if needed
        output_file.parent.mkdir(parents=True, exist_ok=True)
        
        # Sort teams alphabetically
        sorted_teams = sorted(b2b_stats.keys())
        
        # Write CSV file
        with open(output_file, 'w', newline='', encoding='utf-8') as f:
            csv_writer = csv.writer(f)
            
            # Write header
            csv_writer.writerow(['Team', 'HA', 'AH', 'HH', 'AA', 'Total'])
            
            # Write data for each team
            for team in sorted_teams:
                stats = b2b_stats[team]
                csv_writer.writerow([
                    team,
                    stats['HA'],
                    stats['AH'],
                    stats['HH'],
                    stats['AA'],
                    stats['Total']
                ])
        
        return True
    except Exception as e:
        print(f"❌ Failed to save standard answer: {e}")
        import traceback
        traceback.print_exc()
        return False


def read_csv_data(csv_file: Path) -> list:
    """
    Read CSV file and return data as list of lists
    
    Args:
        csv_file: Path to CSV file
        
    Returns:
        List of lists containing CSV data
    """
    data = []
    try:
        with open(csv_file, 'r', encoding='utf-8') as f:
            csv_reader = csv.reader(f)
            for row in csv_reader:
                data.append(row)
        return data
    except Exception as e:
        print(f"❌ Failed to read CSV file: {e}")
        return []


def initialize_google_sheets(google_sheet_db_dir: str, task_dir: Path, 
                            csv_data: list = None, use_generated: bool = False) -> bool:
    """
    Initialize Google Sheets with NHL schedule data using local database
    
    Args:
        google_sheet_db_dir: Directory for Google Sheets database
        task_dir: Task root directory
        csv_data: Pre-generated CSV data (optional)
        use_generated: Whether to use generated data
        
    Returns:
        True if successful, False otherwise
    """
    print("\n🏒 Initializing Google Sheets for NHL B2B Analysis...")
    print(f"📂 Using Google Sheets database: {google_sheet_db_dir}")
    
    try:
        # Initialize Google Sheets Database
        gs_db = GoogleSheetDatabase(data_dir=google_sheet_db_dir)
        
        # Create files directory
        files_dir = task_dir / "files"
        files_dir.mkdir(exist_ok=True)
        
        # Clean up existing sheet ID file
        sheet_id_file = files_dir / "sheet_id.txt"
        if sheet_id_file.exists():
            sheet_id_file.unlink()
            print("   ✓ Removed old sheet ID file")
        
        # Get CSV data
        if csv_data is not None:
            print(f"   ✓ Using pre-generated data")
        else:
            # Read CSV data from file
            csv_file = task_dir / "preprocess" / "NHL Regular 2024-2025 - nhl-202425-asplayed_schedule.csv"
            if not csv_file.exists():
                print(f"❌ CSV file not found: {csv_file}")
                return False
            
            print(f"   ✓ Reading CSV file: {csv_file.name}")
            csv_data = read_csv_data(csv_file)
        
        if not csv_data:
            print("❌ No data found in CSV file")
            return False
        
        print(f"   ✓ Loaded {len(csv_data)} rows from CSV")
        
        # Create a new spreadsheet
        spreadsheet_result = gs_db.create_spreadsheet("NHL Regular 2024-2025")
        spreadsheet_id = spreadsheet_result.get('spreadsheetId') if isinstance(spreadsheet_result, dict) else spreadsheet_result
        print(f"   ✓ Created spreadsheet: {spreadsheet_id}")
        
        # Calculate required sheet dimensions based on CSV data
        num_rows = len(csv_data)
        num_cols = max(len(row) for row in csv_data) if csv_data else 8
        # Add some buffer rows for future data
        required_rows = max(num_rows + 100, 1500)  # At least 1500 rows
        
        # Rename default Sheet1 to "nhl-202425-asplayed_schedule"
        try:
            # Get existing sheets
            spreadsheet = gs_db.get_spreadsheet(spreadsheet_id)
            existing_sheets = spreadsheet.get('sheets', [])
            
            if existing_sheets:
                # Get the name of the first sheet (usually "Sheet1")
                first_sheet_name = existing_sheets[0]['properties']['title']
                first_sheet_id = existing_sheets[0]['properties']['sheetId']
                
                # Check if the default sheet has enough rows
                current_rows = existing_sheets[0]['properties']['gridProperties'].get('rowCount', 1000)
                if current_rows < required_rows:
                    # Need to expand the sheet - update gridProperties
                    print(f"   ℹ️  Expanding sheet from {current_rows} to {required_rows} rows...")
                    # Load and update sheets data directly
                    sheets_data = gs_db.json_db.load_data(gs_db.sheets_file)
                    sheet_key = f"{spreadsheet_id}_{first_sheet_id}"
                    if sheet_key in sheets_data:
                        sheets_data[sheet_key]['gridProperties']['rowCount'] = required_rows
                        sheets_data[sheet_key]['gridProperties']['columnCount'] = max(num_cols, 26)
                        gs_db.json_db.save_data(gs_db.sheets_file, sheets_data)
                        print(f"   ✓ Expanded sheet to {required_rows} rows × {num_cols} cols")
                
                # Rename it to match CSV filename
                sheet_name = "nhl-202425-asplayed_schedule"
                if gs_db.rename_sheet(spreadsheet_id, first_sheet_name, sheet_name):
                    print(f"   ✓ Renamed '{first_sheet_name}' to '{sheet_name}'")
                else:
                    print(f"   ℹ️  Using existing sheet '{first_sheet_name}'")
                    sheet_name = first_sheet_name
            else:
                # Create new sheet if none exists (shouldn't happen)
                sheet_name = "nhl-202425-asplayed_schedule"
                # Create sheet with enough rows for the CSV data
                gs_db.create_sheet(spreadsheet_id, sheet_name, rows=required_rows, cols=num_cols)
                print(f"   ✓ Created '{sheet_name}' sheet ({required_rows} rows × {num_cols} cols)")
        except Exception as e:
            print(f"   ⚠️  Warning: Could not rename sheet: {e}")
            import traceback
            traceback.print_exc()
            sheet_name = "Sheet1"  # fallback
        
        # Update sheet with CSV data
        num_rows = len(csv_data)
        num_cols = max(len(row) for row in csv_data) if csv_data else 0
        
        # Convert column number to letter (A, B, C, ..., Z, AA, AB, ...)
        def col_num_to_letter(n):
            result = ""
            while n > 0:
                n -= 1
                result = chr(ord('A') + (n % 26)) + result
                n //= 26
            return result
        
        end_col = col_num_to_letter(num_cols)
        range_notation = f"A1:{end_col}{num_rows}"
        
        gs_db.update_cells(spreadsheet_id, sheet_name, range_notation, csv_data)
        print(f"   ✓ Populated sheet with {num_rows} rows and {num_cols} columns")
        
        # Display first few rows as preview
        if len(csv_data) > 1:
            print(f"\n   📊 Data Preview:")
            print(f"      Header: {csv_data[0]}")
            if len(csv_data) > 1:
                print(f"      First game: {csv_data[1]}")
            if len(csv_data) > 2:
                print(f"      Second game: {csv_data[2]}")
        
        # Save sheet ID (note: using sheet_id.txt instead of folder_id.txt)
        with open(sheet_id_file, "w") as f:
            f.write(spreadsheet_id)
        print(f"\n   ✓ Sheet ID saved: {spreadsheet_id}")
        
        print("\n✅ Google Sheets initialization completed successfully!")
        return True
        
    except Exception as e:
        print(f"❌ Google Sheets initialization failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def main():
    """Main preprocess orchestration function"""
    parser = ArgumentParser(description="NHL B2B Analysis Task Preprocess (Local Database)")
    parser.add_argument("--agent_workspace", required=False, help="Agent workspace directory")
    parser.add_argument("--task_root", required=False, help="Task root directory (for groundtruth and files)")
    parser.add_argument("--launch_time", required=False, help="Task launch time")
    
    # Data generation control parameters
    parser.add_argument("--skip-generation", action="store_true",
                       help="Skip data generation, use existing CSV file")
    parser.add_argument("--num-games", type=int, default=2000,
                       help="Number of games to generate (default: 20, can be 1000+)")
    parser.add_argument("--num-teams", type=int, default=32,
                       help="Number of teams (default: 4, can be 100+, uses real NHL teams up to 32 then generates virtual teams)")
    parser.add_argument("--start-date", type=str, default="2024-10-01",
                       help="Season start date (default: 2024-10-01)")
    parser.add_argument("--seed", type=int, default=42,
                       help="Random seed for data generation (default: 42)")
    
    # Difficulty presets
    parser.add_argument("--difficulty", type=str, default=None,
                       choices=["easy", "medium", "hard", "expert", "extreme", "massive", "gigantic"],
                       help="Difficulty preset (optional, overrides other parameters)")
    
    args = parser.parse_args()
    
    # Apply difficulty presets (NHL 2024-25 season based)
    if args.difficulty:
        print(f"\n🎲 Using difficulty preset: {args.difficulty.upper()}")
        
        if args.difficulty == "easy":
            # Easy: Early season sample (first 2 weeks)
            args.num_games = 50
            args.num_teams = 10
            args.start_date = "2024-10-08"  # NHL 2024-25 season opening
        elif args.difficulty == "medium":
            # Medium: First month of season
            args.num_games = 150
            args.num_teams = 16
            args.start_date = "2024-10-08"
        elif args.difficulty == "hard":
            # Hard: First quarter of season
            args.num_games = 400
            args.num_teams = 24
            args.start_date = "2024-10-08"
        elif args.difficulty == "expert":
            # Expert: Half season with all teams
            args.num_games = 656  # 32 teams × 41 games / 2 (half season)
            args.num_teams = 32
            args.start_date = "2024-10-08"
        elif args.difficulty == "extreme":
            # Extreme: Full NHL 2024-25 regular season
            args.num_games = 1312  # 32 teams × 82 games / 2 (full season)
            args.num_teams = 32
            args.start_date = "2024-10-08"
        elif args.difficulty == "massive":
            # Massive: Extended league (50 teams)
            args.num_games = 2000
            args.num_teams = 50
            args.start_date = "2024-10-01"
        elif args.difficulty == "gigantic":
            # Gigantic: Large league (100 teams)
            args.num_games = 5000
            args.num_teams = 100
            args.start_date = "2024-10-01"
    else:
        print(f"\n🎲 Using custom parameters")
    
    print("="*60)
    print("NHL B2B ANALYSIS TASK PREPROCESS")
    print("="*60)
    print("This script will (using local database):")
    if not args.skip_generation:
        print("1. Generate NHL schedule data")
        print("2. Initialize Google Sheets database")
        print("3. Create spreadsheet with schedule data")
    else:
        print("1. Initialize Google Sheets database")
        print("2. Load NHL schedule data from CSV")
        print("3. Create spreadsheet with schedule data")
    print("="*60)
    
    if not args.skip_generation:
        print(f"\n📊 Data generation parameters:")
        print(f"   Games: {args.num_games}")
        print(f"   Teams: {args.num_teams}")
        print(f"   Start date: {args.start_date}")
        print(f"   Seed: {args.seed}")
    
    # Get task directory
    # If task_root is provided, use it; otherwise fall back to code directory
    if args.task_root:
        task_dir = Path(args.task_root)
    else:
        # Fallback to code directory (not recommended for parallel execution)
        task_dir = Path(__file__).parent.parent
    
    # Determine database directory
    if args.agent_workspace:
        workspace_parent = Path(args.agent_workspace).parent
        google_sheet_db_dir = str(workspace_parent / "local_db" / "google_sheets")
    else:
        google_sheet_db_dir = str(Path(__file__).parent.parent / "mcps" / "google_sheet" / "data")
    
    print(f"\n📂 Database Directory:")
    print(f"   Google Sheets: {google_sheet_db_dir}")
    
    # Step 0: Generate NHL schedule data (optional)
    csv_data = None
    if not args.skip_generation:
        print(f"\n{'='*60}")
        print("Step 0: Generate NHL Schedule Data")
        print(f"{'='*60}")
        
        try:
            csv_data = generate_nhl_schedule_data(
                num_games=args.num_games,
                num_teams=args.num_teams,
                start_date=args.start_date,
                seed=args.seed
            )
            print(f"   ✓ Generated {len(csv_data) - 1} games")  # -1 for header
            print(f"   ✓ Using {args.num_teams} teams")
            
            # Optionally save generated data to CSV for reference
            # Create preprocess directory if it doesn't exist
            preprocess_dir = task_dir / "preprocess"
            preprocess_dir.mkdir(parents=True, exist_ok=True)
            
            generated_csv_file = preprocess_dir / "generated_schedule.csv"
            try:
                with open(generated_csv_file, 'w', newline='', encoding='utf-8') as f:
                    csv_writer = csv.writer(f)
                    csv_writer.writerows(csv_data)
                print(f"   ✓ Saved generated data to: {generated_csv_file.name}")
            except Exception as e:
                print(f"   ⚠️  Could not save generated CSV: {e}")
            
            # Calculate back-to-back analysis
            print(f"\n   🏒 Calculating back-to-back analysis...")
            b2b_stats = calculate_back_to_back_analysis(csv_data)
            total_b2b = sum(stats['Total'] for stats in b2b_stats.values())
            print(f"   ✓ Calculated back-to-back statistics for {len(b2b_stats)} teams")
            print(f"   ✓ Total back-to-back sets across all teams: {total_b2b}")
            
            # Display sample statistics
            if b2b_stats:
                print(f"\n   📊 Sample back-to-back statistics:")
                for i, (team, stats) in enumerate(sorted(b2b_stats.items())[:3]):
                    print(f"      {team}: HA={stats['HA']}, AH={stats['AH']}, HH={stats['HH']}, AA={stats['AA']}, Total={stats['Total']}")
                if len(b2b_stats) > 3:
                    print(f"      ... and {len(b2b_stats) - 3} more teams")
            
            # Save standard answer to groundtruth_workspace
            groundtruth_dir = task_dir / "groundtruth_workspace"
            groundtruth_dir.mkdir(parents=True, exist_ok=True)
            standard_answer_file = groundtruth_dir / "standard_answer.csv"
            
            if save_standard_answer(b2b_stats, standard_answer_file):
                print(f"\n   ✓ Saved standard answer to: {standard_answer_file}")
            else:
                print(f"\n   ❌ Failed to save standard answer")
            
            # Save generation metadata for evaluation
            metadata = {
                "generation_params": {
                    "num_games": args.num_games,
                    "num_teams": args.num_teams,
                    "start_date": args.start_date,
                    "seed": args.seed,
                    "difficulty": args.difficulty if args.difficulty else "custom"
                },
                "generated_data": {
                    "games_count": len(csv_data) - 1,  # -1 for header
                    "teams_count": args.num_teams,
                    "total_b2b_sets": total_b2b,
                    "teams_with_b2b": len(b2b_stats)
                }
            }
            
            # Save to preprocess directory (already created above)
            metadata_file = preprocess_dir / "generation_metadata.json"
            try:
                with open(metadata_file, 'w', encoding='utf-8') as f:
                    json.dump(metadata, f, indent=2, ensure_ascii=False)
                print(f"   ✓ Saved generation metadata to: {metadata_file.name}")
            except Exception as e:
                print(f"   ⚠️  Could not save metadata: {e}")
            
            # Also save to groundtruth_workspace
            groundtruth_metadata_file = groundtruth_dir / "generation_metadata.json"
            try:
                with open(groundtruth_metadata_file, 'w', encoding='utf-8') as f:
                    json.dump(metadata, f, indent=2, ensure_ascii=False)
                print(f"   ✓ Saved metadata to groundtruth workspace")
            except Exception as e:
                print(f"   ⚠️  Could not save groundtruth metadata: {e}")
            
        except Exception as e:
            print(f"❌ Data generation failed: {e}")
            import traceback
            traceback.print_exc()
            return False
    
    # Clean and initialize Google Sheets database
    print(f"\n{'='*60}")
    print("Step 1: Clean and Initialize Google Sheets Database")
    print(f"{'='*60}")
    
    try:
        # Clean Google Sheets database
        if Path(google_sheet_db_dir).exists():
            nfs_safe_rmtree(google_sheet_db_dir)
            print(f"   ✓ Removed old Google Sheets database")
        Path(google_sheet_db_dir).mkdir(parents=True, exist_ok=True)
        print(f"   ✓ Created Google Sheets database directory")
        
    except Exception as e:
        print(f"❌ Database initialization failed: {e}")
        import traceback
        traceback.print_exc()
        return False
    
    # Initialize Google Sheets with NHL data
    print(f"\n{'='*60}")
    print("Step 2: Initialize Google Sheets with NHL Schedule Data")
    print(f"{'='*60}")
    
    success = initialize_google_sheets(
        google_sheet_db_dir, 
        task_dir, 
        csv_data=csv_data,
        use_generated=(not args.skip_generation)
    )
    
    if success:
        # Set environment variable
        os.environ['GOOGLE_SHEET_DATA_DIR'] = google_sheet_db_dir
        
        # Write environment variable file
        if args.agent_workspace:
            env_file = Path(args.agent_workspace).parent / "local_db" / ".env"
        else:
            env_file = Path(google_sheet_db_dir).parent / ".env"
        
        try:
            env_file.parent.mkdir(parents=True, exist_ok=True)
            with open(env_file, 'w') as f:
                f.write(f"# NHL B2B Analysis Environment Variables\n")
                from datetime import datetime
                f.write(f"# Generated on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
                f.write(f"export GOOGLE_SHEET_DATA_DIR={google_sheet_db_dir}\n")
            print(f"\n📄 Environment variable file created: {env_file}")
        except Exception as e:
            print(f"⚠️ Unable to create environment variable file: {e}")
        
        # Final summary
        print(f"\n{'='*60}")
        print("PREPROCESS SUMMARY")
        print(f"{'='*60}")
        print("✅ All preprocessing steps completed successfully!")
        print("\nInitialized components:")
        if not args.skip_generation:
            print("  - NHL schedule data generated")
            print("  - Back-to-back analysis calculated")
            print("  - Standard answer saved to groundtruth_workspace")
            print("  - Google Sheets database initialized")
            print("  - Spreadsheet created with generated data")
            print(f"\n📊 Generated Data Statistics:")
            print(f"   Games: {len(csv_data) - 1}")  # -1 for header
            print(f"   Teams: {args.num_teams}")
            print(f"   Start date: {args.start_date}")
            print(f"   Random seed: {args.seed}")
            if 'total_b2b' in locals():
                print(f"   Total back-to-back sets: {total_b2b}")
            if args.difficulty:
                print(f"   Difficulty: {args.difficulty.upper()}")
        else:
            print("  - Google Sheets database initialized")
            print("  - NHL schedule data loaded from CSV")
            print("  - Spreadsheet created with schedule data")
        print(f"\n📂 Database Location:")
        print(f"   Google Sheets: {google_sheet_db_dir}")
        
        return True
    else:
        print("\n❌ Preprocessing failed!")
        print("Please check the error messages above and retry.")
        return False


if __name__ == "__main__":
    result = main()
    sys.exit(0 if result else 1)