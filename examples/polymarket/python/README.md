# Polymarket Demo Agent (Python)

Autonomous Polymarket demo CLI using:

- `elizaos-plugin-evm` (wallet / chain utilities)
- `elizaos-plugin-polymarket` (CLOB client provider)

## Install

```bash
cd examples/polymarket/python
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Configure

```bash
export EVM_PRIVATE_KEY="0x..."
export CLOB_API_URL="https://clob.polymarket.com"
export GAMMA_API_URL="https://gamma-api.polymarket.com"

# Only required for placing orders:
export CLOB_API_KEY="..."
export CLOB_API_SECRET="..."
export CLOB_API_PASSPHRASE="..."
```

## Run

```bash
python polymarket_demo.py verify
python polymarket_demo.py verify --private-key "0x..."
python polymarket_demo.py once --network
python polymarket_demo.py run --network --iterations 10 --interval-ms 30000
python polymarket_demo.py run --network --execute --iterations 10 --interval-ms 30000
```

## Tests

```bash
pytest -q
```

