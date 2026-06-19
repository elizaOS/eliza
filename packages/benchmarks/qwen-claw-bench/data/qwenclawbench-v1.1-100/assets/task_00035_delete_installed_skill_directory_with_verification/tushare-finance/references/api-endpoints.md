# Tushare Pro API Endpoints Reference

## Market Data

| Endpoint        | Description                    | Min Points |
|-----------------|--------------------------------|-----------|
| daily           | Daily bar data                 | 120       |
| weekly          | Weekly bar data                | 120       |
| monthly         | Monthly bar data               | 120       |
| adj_factor      | Adjustment factors             | 120       |
| suspend_d       | Suspension info                | 120       |
| daily_basic     | Daily indicators (PE, PB, etc) | 120       |

## Stock Reference

| Endpoint        | Description                    | Min Points |
|-----------------|--------------------------------|-----------|
| stock_basic     | Stock list and basic info      | 120       |
| trade_cal       | Trading calendar               | 120       |
| namechange      | Stock name changes             | 120       |
| hs_const        | HS300/SZ50 constituents        | 120       |
| stk_managers    | Company management             | 120       |

## Financial Data

| Endpoint        | Description                    | Min Points |
|-----------------|--------------------------------|-----------|
| income          | Income statement               | 120       |
| balancesheet    | Balance sheet                  | 120       |
| cashflow        | Cash flow statement            | 120       |
| forecast        | Performance forecast           | 120       |
| express         | Performance express            | 120       |
| dividend        | Dividend distribution          | 120       |
| fina_indicator  | Financial indicators           | 120       |

## Index Data

| Endpoint        | Description                    | Min Points |
|-----------------|--------------------------------|-----------|
| index_basic     | Index list                     | 120       |
| index_daily     | Index daily data               | 120       |
| index_weight    | Index weights                  | 120       |

## Fund Data

| Endpoint        | Description                    | Min Points |
|-----------------|--------------------------------|-----------|
| fund_basic      | Fund list                      | 120       |
| fund_nav        | Fund NAV                       | 120       |
| fund_div        | Fund dividends                 | 120       |
| fund_portfolio  | Fund portfolio                 | 120       |

## Notes

- Points are the minimum Tushare membership points required
- Free accounts start with 120 points
- Higher-tier endpoints require 2000+ points
- See https://tushare.pro/document/1 for full docs
