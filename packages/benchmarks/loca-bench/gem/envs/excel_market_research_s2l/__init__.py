"""Excel Market Research S2L Environment.

This environment simulates a market research scenario where an agent needs to:
1. Read market data from Excel files (Market_Data.xlsx)
2. Extract conversion methodology from the Methodology sheet
3. Convert raw market categories to internal company categories
4. Calculate year-over-year growth rates for specific categories
5. Save results in the specified format (growth_rate.xlsx)

The environment generates dynamic market data with configurable difficulty levels.
"""

from gem.envs.excel_market_research_s2l.excel_market_research_s2l import ExcelMarketResearchS2LEnv

__all__ = ['ExcelMarketResearchS2LEnv']

