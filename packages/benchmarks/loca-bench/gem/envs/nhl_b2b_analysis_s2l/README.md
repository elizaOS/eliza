# NHL B2B Analysis S2L Environment

## Overview

The NHL B2B Analysis S2L environment simulates an NHL schedule analysis scenario where an AI agent needs to:

1. **Read NHL Schedule Data**: Access NHL 2024-2025 season schedule from Google Sheets
2. **Identify Back-to-Back Games**: Find cases where teams play on consecutive days (exactly 1 day apart)
3. **Categorize by Configuration**: Break down back-to-back games into four types:
   - **HA** (Home-Away): First game at home, second game away
   - **AH** (Away-Home): First game away, second game at home
   - **HH** (Home-Home): Both games at home
   - **AA** (Away-Away): Both games away
4. **Save Results**: Export analysis to both Google Sheets and local CSV file

## Task Description

The agent is given access to:
- Google Sheets API (via MCP server) to read schedule data
- Google Drive API (via MCP server) to create folders and sheets
- Filesystem tools to save local CSV files

The agent must:
- Read the NHL 2024-2025 schedule from Google Sheets
- Analyze each team's schedule to identify back-to-back games
- Calculate the count of each back-to-back configuration (HA, AH, HH, AA)
- Calculate the total back-to-back games per team
- Save results to Google Sheets (nhl_b2b_analysis) under NHL-B2B-Analysis folder
- Save a local copy as nhl_b2b_analysis.csv in the workspace

## Environment Configuration

### Initialization Parameters

```python
env = NhlB2bAnalysisS2LEnv(
    task_dir="/path/to/task/dir",        # Directory for task files
    num_games=2000,                       # Number of games to generate
    num_teams=32,                         # Number of teams (uses real NHL teams)
    start_date="2024-10-01",             # Season start date
    seed=42,                              # Random seed for reproducibility
    difficulty="medium",                  # Difficulty preset (optional)
    verbose=False                         # Console logging
)
```

### Difficulty Levels

- **easy**: 50 games, 10 teams (first 2 weeks)
- **medium**: 150 games, 16 teams (first month)
- **hard**: 400 games, 24 teams (first quarter)
- **expert**: 656 games, 32 teams (half season)
- **extreme**: 1312 games, 32 teams (full NHL 2024-25 season)
- **massive**: 2000 games, 50 teams (extended league)
- **gigantic**: 5000 games, 100 teams (large league)

## Directory Structure

```
nhl_b2b_analysis_s2l/
├── nhl_b2b_analysis_s2l.py         # Main environment class
├── __init__.py                      # Package initialization
├── README.md                        # This file
├── task_config.json                # Task configuration
├── preprocess/                      # Preprocessing scripts
│   ├── main.py                      # Main preprocessing script
│   ├── generated_schedule.csv       # Generated schedule data
│   └── generation_metadata.json     # Metadata about generation
├── evaluation/                      # Evaluation scripts
│   ├── main.py                      # Main evaluation script
│   ├── check_local.py               # Local file validation
│   ├── check_sheet_comparison.py    # Google Sheet content validation
│   └── check_sheet_direct.py        # Google Sheet structure validation
└── groundtruth_workspace/           # Ground truth data
    ├── standard_answer.csv          # Expected analysis results
    └── generation_metadata.json     # Generation parameters
```

## Task Workflow

### Reset Phase (Preprocessing)

1. **Generate Schedule Data**: Create NHL game schedule with realistic characteristics
   - Real NHL teams (up to 32) or virtual teams (for larger leagues)
   - Realistic game distribution across season
   - Proper back-to-back frequency (~15-20 per team per season)
   
2. **Calculate Ground Truth**: Compute expected back-to-back analysis
   - Identify all back-to-back situations
   - Categorize by HA, AH, HH, AA configurations
   - Save to groundtruth_workspace/standard_answer.csv
   
3. **Initialize Google Sheets**: Create spreadsheet with schedule data
   - Sheet name: "nhl-202425-asplayed_schedule"
   - Columns: Date, Start Time (Sask), Start Time (ET), Visitor, Score, Home, Score.1, Status
   
4. **Prepare Workspace**: Set up empty agent workspace

### Agent Execution Phase

The agent receives the task instruction with:
- Access to Google Sheets with NHL schedule data
- Task to analyze back-to-back games for all teams
- Requirements for output format and locations

The agent should:
1. Read NHL schedule from Google Sheets
2. Build schedule for each team (with dates and home/away status)
3. Identify consecutive game dates (exactly 1 day apart)
4. Categorize each back-to-back by configuration (HA, AH, HH, AA)
5. Create output with columns: Team, HA, AH, HH, AA, Total
6. Save to Google Sheets (nhl_b2b_analysis under NHL-B2B-Analysis folder)
7. Save local copy as nhl_b2b_analysis.csv

### Evaluation Phase (Step)

1. **Validate Local File**:
   - File exists: nhl_b2b_analysis.csv in agent_workspace
   - Correct format and headers
   - Numeric values match ground truth

2. **Validate Google Sheet (Direct Check)**:
   - Spreadsheet exists with correct name
   - Located under correct folder
   - Proper structure and formatting

3. **Validate Google Sheet (Content Check)**:
   - All teams present
   - Counts match ground truth
   - No missing or extra teams
   - Numeric accuracy within tolerance

## Required Output Format

### CSV/Sheet Headers
```
Team,HA,AH,HH,AA,Total
```

### Sample Output
```
Team,HA,AH,HH,AA,Total
Anaheim Ducks,5,4,2,3,14
Boston Bruins,6,5,3,2,16
Calgary Flames,4,6,1,4,15
...
```

Where:
- **Team**: Team name (sorted alphabetically)
- **HA**: Home-Away back-to-back count
- **AH**: Away-Home back-to-back count
- **HH**: Home-Home back-to-back count
- **AA**: Away-Away back-to-back count
- **Total**: Sum of HA + AH + HH + AA

## Database Configuration

The environment uses local Google Sheets database:
- **Google Sheets**: Spreadsheet storage and manipulation

Database directory is created in `{task_dir}/local_db/google_sheets/`

## NHL Schedule Data Format

The schedule data includes:
- **Date**: Game date (YYYY-MM-DD)
- **Start Time (Sask)**: Saskatchewan timezone
- **Start Time (ET)**: Eastern timezone
- **Visitor**: Away team name
- **Score**: Visitor team score
- **Home**: Home team name
- **Score.1**: Home team score
- **Status**: Game status (Regulation/OT/SO)

## Evaluation Criteria

The task is considered successful when:

1. **Local File Validation** ✓
   - File exists in agent_workspace
   - Correct filename and format
   - All teams present with correct counts
   
2. **Google Sheet Structure Validation** ✓
   - Spreadsheet exists with correct name
   - Located in correct folder
   - Proper structure and headers
   
3. **Google Sheet Content Validation** ✓
   - Numeric values match ground truth
   - All teams accounted for
   - Calculations are accurate

## Example Usage

```python
from gem.envs.nhl_b2b_analysis_s2l import NhlB2bAnalysisS2LEnv

# Create environment with medium difficulty
env = NhlB2bAnalysisS2LEnv(
    task_dir="/tmp/nhl_b2b_task",
    difficulty="medium",
    verbose=True
)

# Reset environment (runs preprocessing)
instruction, info = env.reset()
print(instruction)

# Agent executes task...
# (Read schedule from Google Sheets, analyze back-to-backs, save results)

# Evaluate results
observation, reward, terminated, truncated, info = env.step("claim_done")
print(f"Success: {info['success']}")
print(f"Reward: {reward}")
```

## Parallel Execution Support

The environment is designed to support parallel execution:
- Uses unique logger names based on instance ID
- Generates files in task-specific directories
- Avoids module naming conflicts with unique module names
- Independent database instances per task
- All intermediate files stored in task_dir, not code directory

## Notes

- The environment automatically copies required files from the source task directory
- Preprocessing generates realistic NHL schedule data based on difficulty settings
- Supports both real NHL teams (up to 32) and virtual teams (for larger leagues)
- Back-to-back frequency is realistic (~15-20 per team per season for NHL)
- All intermediate files are stored in the task directory, not the code directory
- The environment supports custom difficulty settings or predefined presets
- Ground truth is calculated during preprocessing for accurate evaluation




