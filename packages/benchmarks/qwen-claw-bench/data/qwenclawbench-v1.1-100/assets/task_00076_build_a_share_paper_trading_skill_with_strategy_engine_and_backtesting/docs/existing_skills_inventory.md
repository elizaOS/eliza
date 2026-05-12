# Existing Skills Inventory

**Last Updated:** 2024-09-10  
**Version:** 3.2  
**Total Skills:** 8

## Overview

This document catalogs all currently deployed skills (automated tools) available in the trading analysis environment. Each skill is listed with its ID, description, and current status.

---

### 1. data_fetcher
- **ID:** skill_001
- **Description:** Fetches real-time and historical market data from configured data sources. Supports A-share stocks, indices, and ETFs. Retrieves OHLCV data, fundamental data, and corporate actions.
- **Status:** Active
- **Last Maintenance:** 2024-08-20

### 2. chart_plotter
- **ID:** skill_002
- **Description:** Generates technical analysis charts including candlestick charts, line charts, and overlay indicators (MA, MACD, RSI, Bollinger Bands). Outputs PNG or interactive HTML.
- **Status:** Active
- **Last Maintenance:** 2024-07-15

### 3. news_aggregator
- **ID:** skill_003
- **Description:** Aggregates financial news from multiple Chinese financial news sources. Supports keyword filtering, sentiment scoring, and relevance ranking for specific stock codes.
- **Status:** Active
- **Last Maintenance:** 2024-09-01

### 4. portfolio_viewer
- **ID:** skill_004
- **Description:** Displays current portfolio holdings, cost basis, unrealized P&L, and asset allocation breakdown. Read-only view of portfolio state.
- **Status:** Active
- **Last Maintenance:** 2024-08-10

### 5. risk_calculator
- **ID:** skill_005
- **Description:** Calculates portfolio risk metrics including VaR (Value at Risk), maximum drawdown, Sharpe ratio, beta, and correlation matrices. Uses historical simulation method.
- **Status:** Active
- **Last Maintenance:** 2024-09-05

### 6. alert_manager
- **ID:** skill_006
- **Description:** Manages price alerts, volume alerts, and technical indicator alerts. Sends notifications via configured channels when conditions are triggered.
- **Status:** Active
- **Last Maintenance:** 2024-08-25

### 7. report_generator
- **ID:** skill_007
- **Description:** Generates periodic performance reports (daily, weekly, monthly) with P&L summaries, trade statistics, and benchmark comparisons. Outputs PDF and CSV formats.
- **Status:** Active
- **Last Maintenance:** 2024-09-08

### 8. market_scanner
- **ID:** skill_008
- **Description:** Scans the market for stocks meeting specified technical or fundamental criteria. Supports custom screening rules including price patterns, volume breakouts, and financial ratios.
- **Status:** Active
- **Last Maintenance:** 2024-08-30

---

## Notes

- No paper trading or simulated trading skill currently exists in the system.
- All skills are read-only or analytical in nature; none execute trades.
- For trade execution, users must use the broker API directly (see broker_api_config.yaml).
- Skill development requests should be submitted through the internal ticketing system.
