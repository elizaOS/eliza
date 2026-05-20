# Bags Fee Claimer 💰

Automatically claims earned fees from [Bags.fm](https://bags.fm) every hour.

## Quick Start

```bash
# Install dependencies
bun install

# Run once
bun run claim

# Run continuously (hourly)
bun run start
```

## Prerequisites

You need Bags credentials saved at `~/.config/bags/credentials.json`:

```json
{
  "jwt_token": "your_365_day_jwt_token",
  "api_key": "your_bags_api_key",
  "moltbook_username": "your_moltbook_username",
  "wallets": ["your_wallet_address"]
}
```

To get these credentials, authenticate via Moltbook:
1. Initialize auth: `POST /agent/auth/init` with your Moltbook username
2. Post the verification content to Moltbook
3. Complete login: `POST /agent/auth/login` with the post ID
4. Create an API key: `POST /agent/dev/keys/create`

## Usage

### Single Claim
```bash
bun run claimer.ts --once
```

### Continuous (Hourly)
```bash
bun run claimer.ts
# or
bun run start
```

### With PM2 (Background Service)
```bash
pm2 start "bun run start" --name bags-claimer
pm2 save
```

### With systemd
Create `/etc/systemd/system/bags-claimer.service`:
```ini
[Unit]
Description=Bags Fee Claimer
After=network.target

[Service]
Type=simple
User=your_user
WorkingDirectory=/path/to/bags-claimer
ExecStart=/usr/local/bin/bun run start
Restart=always

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl enable bags-claimer
sudo systemctl start bags-claimer
```

## Configuration

Environment variables:
- `SOLANA_RPC_URL` - Custom Solana RPC (default: mainnet-beta public RPC)

Constants in `claimer.ts`:
- `CLAIM_INTERVAL_MS` - Claim interval (default: 1 hour)
- `MIN_CLAIMABLE_LAMPORTS` - Minimum amount to trigger claim (default: 0.001 SOL)

## Validation

```bash
bun run test
bun run typecheck
bun run build
```

The local test covers SOL formatting without loading credentials or submitting transactions. A live claim flow still requires Bags credentials, a funded Solana wallet, and an RPC endpoint.

## How It Works

1. Reads credentials from `~/.config/bags/credentials.json`
2. Checks all wallets for claimable fee positions
3. For each position above the minimum threshold:
   - Generates claim transaction via Bags API
   - Exports wallet private key (only when needed)
   - Signs and submits transaction to Solana
4. Logs results and repeats hourly

## Output

```
╔════════════════════════════════════════════════════════════════╗
║              💰 BAGS FEE CLAIMER - Auto Harvest 💰             ║
╚════════════════════════════════════════════════════════════════╝

Agent:    ElizaOK
Wallets:  EYMJDjpXLNwZv9F6C73uhdQdhgq2ZLGGMG49Hjjz3kAy
Mode:     Continuous (every 60 min)
Min:      0.0010 SOL

[2026-02-05T16:27:05.988Z] === Claim cycle for ElizaOK ===
[2026-02-05T16:27:06.535Z] Found 51.7714 SOL for token CDbW2djf...
[2026-02-05T16:27:09.086Z]   ✅ Claimed! https://solscan.io/tx/...

🎉 Claimed 52.2408 SOL from 4 token(s)
```

## Security Notes

- Private keys are only exported when needed for signing
- Credentials file should be readable only by your user: `chmod 600 ~/.config/bags/credentials.json`
- JWT tokens last 365 days - rotate if compromised
