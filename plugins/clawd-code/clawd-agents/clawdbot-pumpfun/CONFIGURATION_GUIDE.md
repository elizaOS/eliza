# Fast Spam Bot Configuration Guide

## Critical Issues Preventing Trading

### 1. Counter Limit Issue (RESOLVED)
✅ **FIXED!** The counter limit issue has been resolved with proper defaults and error handling.

### 2. Missing Environment Variables

Create a `.env` file in the project root with these variables:

```bash
# REQUIRED - Trading will not work without these
YELLOWSTONE_GRPC_HTTP=your_grpc_endpoint_here
YELLOWSTONE_GRPC_TOKEN=your_grpc_token_here
COPY_TRADING_TARGET_ADDRESS=suqh5sHtr8HyJ7q8scBimULPkPpA557prMG47xCHQfK,DfMxre4cKmvogbLrPigxmibVTTQDuzjdXojWzjCXXhzj
WALLET_PRIVATE_KEY=your_wallet_private_key_here

# CRITICAL - Set this to enable trading
COUNTER_LIMIT=10

# Trading Configuration
TOKEN_AMOUNT=0.01
SLIPPAGE=5000
PROTOCOL_PREFERENCE=auto

# Optional Settings
IS_MULTI_COPY_TRADING=true
IS_PROGRESSIVE_SELL=false
IS_COPY_SELLING=false
TRANSACTION_LANDING_SERVICE=zeroslot

# Telegram Notifications (Optional)
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Token Tracking
IS_CHECK_TARGET_WALLET_TOKEN_ACCOUNT=false
COPY_SELLING_LIMIT=1.5

# SOL Wrapping
WRAP_AMOUNT=0.1
```

## Quick Fix for Counter Limit Issue

✅ **FIXED!** The counter limit issue has been resolved:

1. **Fixed infinite loop:** The `import_env_var` function no longer hangs when environment variables are missing
2. **Added defaults:** `COUNTER_LIMIT` now defaults to 10 if not set in the environment
3. **Better error handling:** Missing environment variables are handled gracefully with appropriate defaults

The bot will now work even without a `.env` file, but you should still create one for proper configuration.

## Verification Steps

1. **Check if bot is receiving transactions:**
   ```bash
   cargo run --release
   ```
   Look for logs like "Token transaction detected" or "Target is BUYING"

2. **Check counter status:**
   ```bash
   cargo run --release -- --check-tokens
   ```

3. **Test with a single target:**
   Set `COPY_TRADING_TARGET_ADDRESS` to just one address first

## Common Issues

1. **No transactions detected:** Check your gRPC endpoint and token
2. **Counter limit reached:** Increase `COUNTER_LIMIT` or reset with `--check-tokens`
3. **Transaction failures:** Check wallet balance and slippage settings
4. **Parsing errors:** The bot may not correctly parse complex transactions with multiple protocols

## Debugging Commands

```bash
# Check token tracking status
cargo run --release -- --check-tokens

# Wrap SOL to WSOL
cargo run --release -- --wrap

# Unwrap WSOL to SOL  
cargo run --release -- --unwrap

# Close all token accounts
cargo run --release -- --close
``` 