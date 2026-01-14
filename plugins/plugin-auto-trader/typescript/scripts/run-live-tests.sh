#!/bin/bash

echo "================================================"
echo "🚨 LIVE TRADING TEST RUNNER 🚨"
echo "================================================"
echo ""
echo "⚠️  WARNING: This will execute REAL trades on Solana MAINNET!"
echo "⚠️  Real money will be used for trading!"
echo ""
echo "Requirements:"
echo "  ✓ TRADING_MODE=live in .env"
echo "  ✓ SOLANA_ADDRESS set in .env"
echo "  ✓ SOLANA_PRIVATE_KEY set in .env"
echo "  ✓ Sufficient SOL for gas fees"
echo "  ✓ Sufficient USDC for trading"
echo ""
echo "Test Limits:"
echo "  • 2-minute test: Max $10 per position, $20 daily loss"
echo "  • Risk test: Max $5 per position, $5 daily loss"
echo "  • Single trade: $3 trade size"
echo ""
echo "Press Ctrl+C to cancel, or wait 10 seconds to continue..."

# Countdown
for i in {10..1}; do
    echo -ne "\r$i seconds remaining... "
    sleep 1
done
echo -e "\n"

echo "🚀 Starting live trading tests..."
echo ""

# Check if TRADING_MODE is set to live
if [ "$TRADING_MODE" != "live" ]; then
    echo "⚠️  TRADING_MODE is not set to 'live' in environment"
    echo "   Setting TRADING_MODE=live for this test run..."
    export TRADING_MODE=live
fi

# Run the specific live trading test suite
echo "Running: elizaos test --name \"Live Trading Scenarios\""
elizaos test --name "Live Trading Scenarios"

echo ""
echo "================================================"
echo "✅ Live trading tests completed"
echo "================================================"
echo ""
echo "⚠️  IMPORTANT: Check your wallet for any open positions!"
echo "   https://solscan.io/account/$SOLANA_ADDRESS"
echo "" 