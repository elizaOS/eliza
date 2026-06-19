# Excel Market Research S2L Environment

This environment simulates a market research scenario where an agent needs to analyze Excel data, convert market categories, and calculate growth rates.

## Overview

The agent receives market sales data in Excel format and needs to:
1. Read `Market_Data.xlsx` containing raw market data
2. Extract conversion methodology from the `Methodology` sheet
3. Convert raw market categories to internal company categories
4. Calculate year-over-year growth rates for specific categories
5. Handle mixed units (mn USD vs bn USD) correctly
6. Save results in `growth_rate.xlsx` following the specified format

## Directory Structure

```
excel_market_research_s2l/
├── excel_market_research_s2l.py   # Main environment implementation
├── __init__.py                     # Package initialization
├── README.md                       # This file
├── simple_test.py                  # Simple import/instantiation tests
├── test_env.py                     # Comprehensive environment tests
├── preprocess/                     # Data generation scripts
│   ├── main.py                     # Preprocessing entry point
│   ├── generate_market_data.py    # Market data generator
│   └── README.md                   # Preprocessing documentation
├── evaluation/                     # Evaluation scripts
│   ├── main.py                     # Evaluation entry point
│   └── check_local.py              # Local evaluation logic
├── initial_workspace/              # Template workspace files
└── docs/                           # Documentation
    └── task.md                     # Task description
```

## Task Directory Structure (Runtime)

When an environment instance is created with `task_dir`, the following structure is generated:

```
{task_dir}/
├── agent_workspace/                # Agent's working directory
│   ├── Market_Data.xlsx            # Input data file
│   ├── Market_Data_Format.xlsx     # Expected output format
│   └── task_specific.md            # Task-specific instructions
├── initial_workspace/              # Copy of initial files
├── groundtruth_workspace/          # Ground truth for evaluation
│   ├── Market_Data_gt.csv          # Correct growth rates
│   ├── README.md                   # Calculation steps
│   └── metadata.json               # Task metadata
├── local_db/                       # Database directory (unused)
└── logs/                           # Environment logs
    └── env.log                     # Detailed execution logs
```

## Usage

### Basic Usage

```python
from gem.envs.excel_market_research_s2l import ExcelMarketResearchS2LEnv

# Create environment with default parameters
env = ExcelMarketResearchS2LEnv(
    task_dir="/path/to/task_directory",
    difficulty="medium",
    seed=42,
    verbose=True
)

# Get task instruction
instruction, info = env.reset()

# Agent performs task...
# When done, evaluate the result
observation, reward, terminated, truncated, info = env.step("claim_done")
```

### Difficulty Levels

The environment supports different difficulty levels:

| Level  | Raw Categories | Internal Categories | Years | Time Period |
|--------|----------------|---------------------|-------|-------------|
| easy   | 3              | 2                   | 6     | 2019-2024   |
| medium | 5              | 3                   | 11    | 2014-2024   |
| hard   | 10             | 5                   | 11    | 2014-2024   |
| expert | 15             | 7                   | 15    | 2010-2024   |

### Custom Parameters

You can also specify custom parameters instead of using difficulty presets:

```python
env = ExcelMarketResearchS2LEnv(
    task_dir="/path/to/task_directory",
    seed=42,
    start_year=2010,
    num_years=15,
    num_raw_categories=20,
    num_internal_categories=8,
    verbose=True
)
```

### Parameters

- **task_dir** (str): Directory for task-related files (required)
- **seed** (int): Random seed for reproducibility (default: 42)
- **start_year** (int): Starting year for data (default: 1989)
- **num_years** (int): Number of years of data (default: 20)
- **num_raw_categories** (int): Number of raw market categories (default: 30)
- **num_internal_categories** (int): Number of internal categories (default: 5)
- **difficulty** (str): Difficulty preset - "easy", "medium", "hard", or "expert" (optional)
- **verbose** (bool): Whether to output to console (default: False)

## Key Features

✅ **Dynamic Data Generation**: Generates realistic market data with configurable parameters
✅ **Multiple Difficulty Levels**: Supports easy, medium, hard, and expert presets
✅ **Mixed Units**: Raw data contains mixed units (mn USD and bn USD) for added complexity
✅ **Automatic Groundtruth**: Generates ground truth for evaluation automatically
✅ **Reproducible**: Uses seed for reproducible data generation
✅ **Parallel-Safe**: Uses unique module names to avoid conflicts when running in parallel

## Testing

### Simple Import Test

```bash
python3 simple_test.py
```

This tests basic import and instantiation.

### Comprehensive Environment Test

```bash
python3 test_env.py
```

This tests:
- Environment initialization
- Reset and preprocessing
- Directory structure
- Generated files
- Different difficulty levels

## Evaluation

The environment evaluates the agent's output by:
1. Checking if `growth_rate.xlsx` exists in the agent workspace
2. Verifying all required columns are present (Year, Growth Rate %, category columns)
3. Comparing growth rate calculations with ground truth
4. Requiring 100% accuracy with ±1% tolerance for numerical values

### Success Criteria

To pass the evaluation, the agent must:
- Create `growth_rate.xlsx` file
- Include all required columns
- Calculate all growth rates accurately (within 1% tolerance)
- Match the expected format

## Important Notes

⚠️ **Module Conflicts**: The environment uses unique module names (`excel_market_research_s2l_{id(self)}`) to avoid conflicts when running multiple instances in parallel.

⚠️ **File Locations**: All generated files (initial_workspace, groundtruth_workspace, etc.) are stored in the task directory, NOT in the code directory.

⚠️ **Units**: Pay attention to units in the raw data! Some categories use "mn USD" (millions) while others use "bn USD" (billions). All values must be converted to the same unit before calculation.

## Dependencies

### Environment Dependencies
The environment implementation requires:
- Python 3.7+
- openpyxl (for Excel file handling in evaluation)
- pandas (for data processing in evaluation)
- numpy (for numerical calculations in evaluation)

### Agent Runtime Dependencies
✅ **Automatically Handled**: This environment includes a `pyproject.toml` in the workspace that declares all required dependencies (openpyxl, pandas, numpy).

When agents use `python_execute` tool (which runs code via `uv run`), dependencies are automatically installed on first use.

**How it works**:
- `python_execute` uses `uv run` to execute code
- `uv` reads `pyproject.toml` from agent workspace
- Dependencies are automatically installed in isolated environment
- No manual setup required! ✅

**Alternative**: Agents can also use the Excel MCP server directly, which doesn't require any Python packages.

See [RUNTIME_DEPENDENCIES.md](RUNTIME_DEPENDENCIES.md) for technical details and troubleshooting.

## Integration with GEM

This environment is part of the GEM (Generalized Environment for MCP) framework and follows the standard environment interface:

- `reset()`: Initializes the task and returns instructions
- `step(action)`: Evaluates the agent's solution
- Returns standard gym-style tuples: (observation, reward, terminated, truncated, info)

## Related Files

- **mcpbench_dev/tasks/weihao/excel-market-research-s2l/**: Original task definition
- **gem/core/**: Base environment class
- **gem/utils/constants.py**: Shared constants

## Support

For issues or questions:
1. Check the test scripts (`simple_test.py`, `test_env.py`)
2. Review the logs in `{task_dir}/logs/env.log`
3. Check preprocessing documentation in `preprocess/README.md`

---

**Version**: 1.0  
**Status**: Production Ready ✅

