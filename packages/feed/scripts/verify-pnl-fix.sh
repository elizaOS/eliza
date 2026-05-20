#!/bin/bash
# Verify PnL fix for all user-controlled agents on staging

echo "🔍 Verifying PnL fix for user-controlled agents..."
echo ""

# Check if cookies file exists
if [ ! -f ".staging-cookies.txt" ]; then
  echo "⚠️  Create .staging-cookies.txt with your auth cookies first"
  echo "Example format:"
  echo "privy-token=eyJ...; privy-id-token=eyJ...; privy-session=t"
  exit 1
fi

COOKIES=$(cat .staging-cookies.txt)
BASE_URL="https://staging.babylon.market"

# Array of known user-controlled agent IDs (update with actual IDs)
# To find agents with closed positions, query:
#   SELECT DISTINCT "poolId" FROM "PoolPosition" WHERE "closedAt" IS NOT NULL LIMIT 10;
#   SELECT DISTINCT "userId" FROM "PerpPosition" WHERE "closedAt" IS NOT NULL LIMIT 10;
AGENT_IDS=(
  "273508387734421504"  # Lumen Oracle
  # Add more agent IDs here
)

echo "Testing ${#AGENT_IDS[@]} agents..."
echo ""

for AGENT_ID in "${AGENT_IDS[@]}"; do
  echo "📊 Agent: $AGENT_ID"
  
  RESPONSE=$(curl -s "$BASE_URL/api/npc/$AGENT_ID/portfolio" \
    -H "accept: */*" \
    -b "$COOKIES")
  
  # Extract realizedPnL using jq
  REALIZED_PNL=$(echo "$RESPONSE" | jq -r '.portfolio.realizedPnL // "null"')
  UNREALIZED_PNL=$(echo "$RESPONSE" | jq -r '.portfolio.unrealizedPnL // "null"')
  POSITION_COUNT=$(echo "$RESPONSE" | jq -r '.portfolio.positionCount // 0')
  
  if [ "$REALIZED_PNL" = "null" ]; then
    echo "   ❌ Failed to fetch data"
  elif [ "$REALIZED_PNL" = "0" ] && [ "$POSITION_COUNT" = "0" ]; then
    echo "   ✅ realizedPnL: \$0.00 (no positions - expected)"
  else
    echo "   ✅ realizedPnL: \$$REALIZED_PNL"
    echo "      unrealizedPnL: \$$UNREALIZED_PNL"
    echo "      positions: $POSITION_COUNT"
  fi
  echo ""
done

echo "✅ Verification complete!"
echo ""
echo "If all agents show realizedPnL != 0 when they have closed positions, the fix is working!"
