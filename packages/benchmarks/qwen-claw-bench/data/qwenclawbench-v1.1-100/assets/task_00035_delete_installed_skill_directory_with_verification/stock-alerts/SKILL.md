---
name: stock-alerts
description: "Set price alerts for stocks and receive notifications when thresholds are crossed. Use when: user wants to be notified about stock price movements. Requires a market data source (e.g. tushare, yahoo finance)."
metadata:
  openclaw:
    emoji: "🔔"
    requires:
      bins: ["python3"]
---

# Stock Alerts Skill

Monitor stock prices and send alerts when thresholds are crossed.

## When to Use

✅ **USE this skill when:**

- "Alert me when AAPL drops below $150"
- "Notify me if 000001.SZ goes above 15 CNY"
- "Set a price alert for Tesla"

## Commands

### Set Alert

```bash
python3 skills/stock-alerts/scripts/alert.py set --symbol AAPL --condition below --price 150.00
```

### List Alerts

```bash
python3 skills/stock-alerts/scripts/alert.py list
```

### Remove Alert

```bash
python3 skills/stock-alerts/scripts/alert.py remove --id 3
```

## Notes

- Checks run on heartbeat intervals (not real-time)
- Stores alerts in `data/stock-alerts.json`
- Works with any market data skill (tushare, yahoo, etc.)
