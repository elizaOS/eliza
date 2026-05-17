# Trenches Dataset Python Examples

This directory contains Python scripts for analyzing and exploring the Trenches Discord chat dataset.

## Scripts

### 1. `comprehensive_analysis.py`
**Purpose**: Complete dataset analysis with all metrics and visualizations

**Features**:
- Dataset overview and statistics
- Top and worst performer analyses
- Performance distribution analysis
- Token analysis and rankings
- Generates 5 comprehensive visualizations
- Creates a JSON summary report

**Usage**:
```bash
python comprehensive_analysis.py

# With custom data directory
python comprehensive_analysis.py --data-dir /path/to/data
```

**Output**:
- `comprehensive_timeline.png` - Daily volume and hourly patterns
- `comprehensive_performance.png` - Performance distributions
- `comprehensive_tokens.png` - Token analysis
- `comprehensive_users.png` - User performance
- `comprehensive_sentiment.png` - Sentiment analysis
- `comprehensive_analysis_report.json` - Summary report

### 2. `interactive_explorer.py`
**Purpose**: Interactive exploration of specific tokens, users, or time periods

**Features**:
- Detailed token analysis with custom visualizations
- User portfolio and performance analysis
- Time period analysis
- Duplicate call detection

**Usage**:
```bash
# Analyze a specific token
python interactive_explorer.py --token SMORE

# Analyze a specific user
python interactive_explorer.py --user "Pmore"

# Analyze a time period
python interactive_explorer.py --start-date 2024-12-01 --end-date 2024-12-31

# Combine multiple analyses
python interactive_explorer.py --token SMORE --user "Pmore"
```

### 3. `load_dataset.py`
**Purpose**: Core dataset loader and basic analysis functions

**Features**:
- `TrenchesDataset` class for loading all data components
- Basic filtering and querying functions
- Simple visualization methods
- AI16Z (native token) filtering
- Duplicate call filtering

**Usage**:
```python
from load_dataset import TrenchesDataset

# Initialize and load data
dataset = TrenchesDataset("../../data")
dataset.load_messages()
dataset.load_calls()
dataset.load_tokens()
dataset.load_users()

# Query specific data
token_calls = dataset.get_token_calls("SMORE")
user_calls = dataset.get_user_calls("user_id_here")
```

## Requirements

```bash
pip install pandas matplotlib seaborn
```

## Data Directory Structure

The scripts expect data in the following structure:
```
data/
├── messages.json
├── calls.json
├── tokens.json
├── users.json
├── users_with_metrics.json (optional)
├── calculated_success_metrics.json (optional)
├── realistic_success_metrics.json (optional)
└── price_history/
    └── [token_address].json
```

## Notes

- All scripts automatically filter out the native token (AI16Z)
- Duplicate calls (same user/token/sentiment within 1 hour) are filtered
- Timestamps are in UTC
- Users need 5+ different tokens and 10+ calls for top performer lists 