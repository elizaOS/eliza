#!/bin/bash

# Test all API keys for the n8n plugin
# This script validates that all required API keys are working

echo "🔧 N8n Plugin API Key Tester"
echo "============================"
echo ""

# Color codes for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Track success/failure
TOTAL_TESTS=0
PASSED_TESTS=0

# Function to test an API
test_api() {
    local name=$1
    local test_command=$2
    local expected_response=$3
    
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    
    echo -n "Testing $name... "
    
    # Run the test command and capture output
    output=$(eval "$test_command" 2>&1)
    
    # Check if the response contains expected pattern
    if echo "$output" | grep -q "$expected_response"; then
        echo -e "${GREEN}✓ PASSED${NC}"
        PASSED_TESTS=$((PASSED_TESTS + 1))
        return 0
    else
        echo -e "${RED}✗ FAILED${NC}"
        echo "  Error: $output" | head -n 2
        return 1
    fi
}

echo "1. Testing N8n API..."
if [ -z "$N8N_API_KEY" ] || [ -z "$N8N_BASE_URL" ]; then
    echo -e "${RED}✗ FAILED${NC} - N8N_API_KEY or N8N_BASE_URL not set"
else
    test_api "N8n" \
        "curl -s -X GET '$N8N_BASE_URL/api/v1/workflows' -H 'X-N8N-API-KEY: $N8N_API_KEY'" \
        '"data"\|"error"'
fi

echo ""
echo "2. Testing OpenWeather API..."
if [ -z "$OPENWEATHER_API_KEY" ]; then
    echo -e "${YELLOW}⚠ SKIPPED${NC} - OPENWEATHER_API_KEY not set"
else
    test_api "OpenWeather" \
        "curl -s 'https://api.openweathermap.org/data/2.5/weather?q=London&appid=$OPENWEATHER_API_KEY'" \
        '"weather"\|"main"'
fi

echo ""
echo "3. Testing Alpha Vantage API..."
if [ -z "$ALPHA_VANTAGE_API_KEY" ]; then
    echo -e "${YELLOW}⚠ SKIPPED${NC} - ALPHA_VANTAGE_API_KEY not set"
else
    test_api "Alpha Vantage" \
        "curl -s 'https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=AAPL&apikey=$ALPHA_VANTAGE_API_KEY'" \
        '"Global Quote"\|"Error Message"'
fi

echo ""
echo "4. Testing News API..."
if [ -z "$NEWS_API_KEY" ]; then
    echo -e "${YELLOW}⚠ SKIPPED${NC} - NEWS_API_KEY not set"
else
    test_api "News API" \
        "curl -s 'https://newsapi.org/v2/top-headlines?country=us&apiKey=$NEWS_API_KEY'" \
        '"articles"\|"status"'
fi

echo ""
echo "5. Testing OpenAI API (for translation)..."
if [ -z "$OPENAI_API_KEY" ]; then
    echo -e "${YELLOW}⚠ SKIPPED${NC} - OPENAI_API_KEY not set"
else
    test_api "OpenAI" \
        "curl -s https://api.openai.com/v1/models -H 'Authorization: Bearer $OPENAI_API_KEY'" \
        '"data"\|"model"'
fi

# Optional: Test DeepL if configured
if [ ! -z "$DEEPL_API_KEY" ]; then
    echo ""
    echo "5b. Testing DeepL API (alternative translation)..."
    test_api "DeepL" \
        "curl -s -X POST 'https://api-free.deepl.com/v2/translate' -d auth_key=$DEEPL_API_KEY -d 'text=Hello' -d 'target_lang=ES'" \
        '"translations"\|"error"'
fi

echo ""
echo "6. Testing SendGrid API..."
if [ -z "$SENDGRID_API_KEY" ]; then
    echo -e "${YELLOW}⚠ SKIPPED${NC} - SENDGRID_API_KEY not set"
else
    test_api "SendGrid" \
        "curl -s -X GET 'https://api.sendgrid.com/v3/user/profile' -H 'Authorization: Bearer $SENDGRID_API_KEY'" \
        '"username"\|"errors"'
fi

echo ""
echo "7. Testing Slack Webhook..."
if [ -z "$SLACK_WEBHOOK_URL" ]; then
    echo -e "${YELLOW}⚠ SKIPPED${NC} - SLACK_WEBHOOK_URL not set"
else
    # Don't actually post to Slack, just verify URL format
    echo -n "Testing Slack Webhook... "
    if [[ $SLACK_WEBHOOK_URL =~ ^https://hooks\.slack\.com/services/ ]]; then
        echo -e "${GREEN}✓ PASSED${NC} - Valid webhook URL format"
        PASSED_TESTS=$((PASSED_TESTS + 1))
    else
        echo -e "${RED}✗ FAILED${NC} - Invalid webhook URL format"
    fi
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
fi

# Summary
echo ""
echo "============================"
echo "Test Summary"
echo "============================"
echo "Total tests run: $TOTAL_TESTS"
echo -e "Passed: ${GREEN}$PASSED_TESTS${NC}"
echo -e "Failed: ${RED}$((TOTAL_TESTS - PASSED_TESTS))${NC}"

if [ $TOTAL_TESTS -eq 0 ]; then
    echo ""
    echo -e "${YELLOW}⚠ WARNING: No API keys configured!${NC}"
    echo "Please set the required environment variables in your .env file"
    exit 1
elif [ $PASSED_TESTS -eq $TOTAL_TESTS ]; then
    echo ""
    echo -e "${GREEN}✅ All API keys are working correctly!${NC}"
    exit 0
else
    echo ""
    echo -e "${YELLOW}⚠ Some API keys failed validation${NC}"
    echo "Please check the failed tests above"
    exit 1
fi 