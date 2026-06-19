"""NHL B2B Analysis S2L Environment.

This environment simulates an NHL schedule analysis scenario where
the agent needs to:
1. Read NHL schedule data from Google Sheets
2. Identify back-to-back games for each team
3. Categorize back-to-back games by home/away configuration (HA, AH, HH, AA)
4. Save analysis results to Google Sheets and local CSV file

The environment supports configurable difficulty levels and parallel execution.
"""

from gem.envs.nhl_b2b_analysis_s2l.nhl_b2b_analysis_s2l import (
    NhlB2bAnalysisS2LEnv,
)

__all__ = [
    "NhlB2bAnalysisS2LEnv",
]




