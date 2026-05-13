# daily_stock_analysis

Automated daily stock analysis pipeline. Fetches OHLCV data from Yahoo Finance, computes technical indicators (RSI, MACD, Bollinger Bands), generates buy/sell signals, and sends notifications via Feishu webhook.

## Setup

```bash
pip install -r requirements.txt
```

## Usage

```bash
python src/main.py --config config/settings.yaml
python src/main.py --dry-run  # skip notifications
```

## Deployment

See `server/` directory for systemd service and Docker deployment configs.

### Current Status
- [x] Local development complete
- [x] Docker image built
- [ ] Server integration (systemd/cron) — **pending**
- [ ] CI/CD pipeline

## Configuration

Edit `config/settings.yaml` to customize the watchlist, indicator parameters, and Feishu webhook settings.
