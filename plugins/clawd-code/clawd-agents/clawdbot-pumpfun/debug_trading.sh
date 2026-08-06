#!/bin/bash

echo "=== Fast Spam Bot Trading Debug Script ==="
echo

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo "❌ ERROR: .env file not found!"
    echo "Please create a .env file with the required environment variables."
    echo "See CONFIGURATION_GUIDE.md for details."
    echo
    exit 1
else
    echo "✅ .env file found"
fi

# Check required environment variables
echo
echo "=== Checking Environment Variables ==="

# Function to check env var
check_env_var() {
    local var_name=$1
    local value=$(grep "^${var_name}=" .env | cut -d'=' -f2-)
    if [ -z "$value" ]; then
        echo "❌ $var_name: NOT SET"
        return 1
    else
        echo "✅ $var_name: SET"
        return 0
    fi
}

# Check critical variables
critical_vars=("YELLOWSTONE_GRPC_HTTP" "YELLOWSTONE_GRPC_TOKEN" "COPY_TRADING_TARGET_ADDRESS" "WALLET_PRIVATE_KEY" "COUNTER_LIMIT")
missing_critical=0

for var in "${critical_vars[@]}"; do
    if ! check_env_var "$var"; then
        missing_critical=$((missing_critical + 1))
    fi
done

echo
echo "=== Counter Limit Check ==="
counter_limit=$(grep "^COUNTER_LIMIT=" .env | cut -d'=' -f2-)
if [ -z "$counter_limit" ] || [ "$counter_limit" -eq 0 ]; then
    echo "❌ CRITICAL: COUNTER_LIMIT is 0 or not set!"
    echo "This will prevent ALL trading. Set COUNTER_LIMIT=10 or higher."
else
    echo "✅ COUNTER_LIMIT: $counter_limit"
fi

echo
echo "=== Build Check ==="
if cargo build --release; then
    echo "✅ Build successful"
else
    echo "❌ Build failed"
    exit 1
fi

echo
echo "=== Test Run ==="
echo "Starting bot for 30 seconds to check for errors..."
timeout 30s cargo run --release 2>&1 | head -20

echo
echo "=== Summary ==="
if [ $missing_critical -gt 0 ]; then
    echo "❌ $missing_critical critical environment variables are missing"
    echo "Please fix these before running the bot"
else
    echo "✅ All critical environment variables are set"
fi

echo
echo "=== Next Steps ==="
echo "1. If environment variables are missing, add them to .env"
echo "2. If COUNTER_LIMIT is 0, change it to 10 or higher"
echo "3. Run: cargo run --release"
echo "4. Check logs for 'Token transaction detected' or 'Target is BUYING'"
echo "5. Use: cargo run --release -- --check-tokens to see counter status" 