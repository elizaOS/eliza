#!/bin/bash
#
# Manual OAuth API Testing Script
#
# This script provides comprehensive manual testing for the OAuth API endpoints.
# It tests both happy paths and error scenarios.
#
# Prerequisites:
# 1. Server running at http://localhost:3000 (bun run dev)
# 2. Valid API key (set below or via TEST_API_KEY env var)
# 3. For Google tests: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env
#
# Usage:
#   ./tests/manual/oauth-manual-test.sh
#   TEST_API_KEY=your_key ./tests/manual/oauth-manual-test.sh
#   TEST_BASE_URL=http://custom:3000 ./tests/manual/oauth-manual-test.sh
#

set -e

# Configuration
BASE_URL="${TEST_BASE_URL:-http://localhost:3000}"
API_KEY="${TEST_API_KEY:-}"
VERBOSE="${VERBOSE:-false}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test counters
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0

echo "======================================"
echo "  OAuth API Manual Tests"
echo "======================================"
echo ""
echo "Base URL: $BASE_URL"

if [ -z "$API_KEY" ]; then
    echo -e "${YELLOW}Warning: No API_KEY set. Some tests will fail.${NC}"
    echo "Set TEST_API_KEY environment variable to run authenticated tests."
    echo ""
fi

# Helper function for testing endpoints
test_endpoint() {
    local method=$1
    local endpoint=$2
    local description=$3
    local data=$4
    local expected_status=$5
    local should_contain=$6
    
    echo -e "\n${BLUE}Testing: $description${NC}"
    echo "  $method $endpoint"
    
    local response
    local status
    local body
    
    if [ "$method" = "GET" ]; then
        if [ -n "$API_KEY" ]; then
            response=$(curl -s -w "\n%{http_code}" -X $method "$BASE_URL$endpoint" \
                -H "Authorization: Bearer $API_KEY" \
                -H "Content-Type: application/json" 2>&1) || true
        else
            response=$(curl -s -w "\n%{http_code}" -X $method "$BASE_URL$endpoint" \
                -H "Content-Type: application/json" 2>&1) || true
        fi
    else
        if [ -n "$API_KEY" ]; then
            response=$(curl -s -w "\n%{http_code}" -X $method "$BASE_URL$endpoint" \
                -H "Authorization: Bearer $API_KEY" \
                -H "Content-Type: application/json" \
                -d "$data" 2>&1) || true
        else
            response=$(curl -s -w "\n%{http_code}" -X $method "$BASE_URL$endpoint" \
                -H "Content-Type: application/json" \
                -d "$data" 2>&1) || true
        fi
    fi
    
    status=$(echo "$response" | tail -1)
    body=$(echo "$response" | sed '$d')
    
    local passed=true
    
    # Check status code
    if [ "$status" = "$expected_status" ]; then
        echo -e "  ${GREEN}✓ Status: $status (expected: $expected_status)${NC}"
    else
        echo -e "  ${RED}✗ Status: $status (expected: $expected_status)${NC}"
        passed=false
    fi
    
    # Check response contains expected string
    if [ -n "$should_contain" ]; then
        if echo "$body" | grep -q "$should_contain"; then
            echo -e "  ${GREEN}✓ Response contains: $should_contain${NC}"
        else
            echo -e "  ${RED}✗ Response missing: $should_contain${NC}"
            passed=false
        fi
    fi
    
    if [ "$VERBOSE" = "true" ]; then
        echo "  Response: $(echo "$body" | head -c 500)"
    fi
    
    if [ "$passed" = "true" ]; then
        ((TESTS_PASSED++))
    else
        ((TESTS_FAILED++))
        echo "  Full response: $body"
    fi
}

# Skip helper
skip_test() {
    local description=$1
    local reason=$2
    echo -e "\n${YELLOW}Skipping: $description${NC}"
    echo "  Reason: $reason"
    ((TESTS_SKIPPED++))
}

echo ""
echo "======================================"
echo "  1. List Providers (Public Endpoint)"
echo "======================================"

test_endpoint "GET" "/api/v1/oauth/providers" \
    "List all OAuth providers (no auth required)" \
    "" \
    "200" \
    "providers"

test_endpoint "GET" "/api/v1/oauth/providers" \
    "Should include Google provider" \
    "" \
    "200" \
    '"id":"google"'

test_endpoint "GET" "/api/v1/oauth/providers" \
    "Should include Twitter provider" \
    "" \
    "200" \
    '"id":"twitter"'

test_endpoint "GET" "/api/v1/oauth/providers" \
    "Should include Twilio provider" \
    "" \
    "200" \
    '"id":"twilio"'

test_endpoint "GET" "/api/v1/oauth/providers" \
    "Should include Blooio provider" \
    "" \
    "200" \
    '"id":"blooio"'

test_endpoint "GET" "/api/v1/oauth/providers" \
    "Should NOT include Discord (excluded by design)" \
    "" \
    "200" \
    "configured"

echo ""
echo "======================================"
echo "  2. Authentication Tests"
echo "======================================"

test_endpoint "GET" "/api/v1/oauth/connections" \
    "List connections without auth (should fail)" \
    "" \
    "401" \
    ""

test_endpoint "POST" "/api/v1/oauth/connect" \
    "Connect without auth (should fail)" \
    '{"platform": "google"}' \
    "401" \
    ""

test_endpoint "GET" "/api/v1/oauth/token/google" \
    "Get token without auth (should fail)" \
    "" \
    "401" \
    ""

echo ""
echo "======================================"
echo "  3. Validation Tests"
echo "======================================"

if [ -n "$API_KEY" ]; then
    test_endpoint "POST" "/api/v1/oauth/connect" \
        "Connect with missing platform" \
        '{}' \
        "400" \
        "VALIDATION_ERROR"
    
    test_endpoint "POST" "/api/v1/oauth/connect" \
        "Connect with empty platform" \
        '{"platform": ""}' \
        "400" \
        ""
    
    test_endpoint "POST" "/api/v1/oauth/connect" \
        "Connect with invalid platform" \
        '{"platform": "invalid_platform"}' \
        "400" \
        "PLATFORM_NOT_SUPPORTED"
    
    test_endpoint "POST" "/api/v1/oauth/connect" \
        "Connect with excluded platform (Discord)" \
        '{"platform": "discord"}' \
        "400" \
        "PLATFORM_NOT_SUPPORTED"
    
    test_endpoint "POST" "/api/v1/oauth/connect" \
        "Invalid JSON body" \
        '{ invalid json }' \
        "400" \
        ""
    
    test_endpoint "GET" "/api/v1/oauth/token/INVALID_PLATFORM" \
        "Token for unsupported platform (uppercase)" \
        "" \
        "400" \
        "PLATFORM_NOT_SUPPORTED"
else
    skip_test "Validation tests" "No API_KEY provided"
fi

echo ""
echo "======================================"
echo "  4. Initiate OAuth Flow"
echo "======================================"

if [ -n "$API_KEY" ]; then
    test_endpoint "POST" "/api/v1/oauth/connect" \
        "Initiate Google OAuth (if configured)" \
        '{"platform": "google", "redirectUrl": "/test"}' \
        "200" \
        "authUrl"
    
    test_endpoint "POST" "/api/v1/oauth/connect" \
        "Initiate Twilio (API Key platform)" \
        '{"platform": "twilio"}' \
        "200" \
        "requiresCredentials"
    
    test_endpoint "POST" "/api/v1/oauth/connect" \
        "Initiate Blooio (API Key platform)" \
        '{"platform": "blooio"}' \
        "200" \
        "requiresCredentials"
else
    skip_test "OAuth flow tests" "No API_KEY provided"
fi

echo ""
echo "======================================"
echo "  5. List Connections"
echo "======================================"

if [ -n "$API_KEY" ]; then
    test_endpoint "GET" "/api/v1/oauth/connections" \
        "List all connections" \
        "" \
        "200" \
        "connections"
    
    test_endpoint "GET" "/api/v1/oauth/connections?platform=google" \
        "List Google connections" \
        "" \
        "200" \
        "connections"
    
    test_endpoint "GET" "/api/v1/oauth/connections?platform=twitter" \
        "List Twitter connections" \
        "" \
        "200" \
        "connections"
    
    test_endpoint "GET" "/api/v1/oauth/connections?platform=invalid_platform" \
        "List connections for invalid platform" \
        "" \
        "200" \
        "connections"
else
    skip_test "Connection listing tests" "No API_KEY provided"
fi

echo ""
echo "======================================"
echo "  6. Get Token by Platform"
echo "======================================"

if [ -n "$API_KEY" ]; then
    test_endpoint "GET" "/api/v1/oauth/token/google" \
        "Get Google token (may fail if not connected)" \
        "" \
        "401" \
        "PLATFORM_NOT_CONNECTED"
    
    test_endpoint "GET" "/api/v1/oauth/token/twitter" \
        "Get Twitter token (may fail if not connected)" \
        "" \
        "401" \
        "PLATFORM_NOT_CONNECTED"
    
    test_endpoint "GET" "/api/v1/oauth/token/twilio" \
        "Get Twilio token (may fail if not connected)" \
        "" \
        "401" \
        "PLATFORM_NOT_CONNECTED"
    
    test_endpoint "GET" "/api/v1/oauth/token/blooio" \
        "Get Blooio token (may fail if not connected)" \
        "" \
        "401" \
        "PLATFORM_NOT_CONNECTED"
else
    skip_test "Token by platform tests" "No API_KEY provided"
fi

echo ""
echo "======================================"
echo "  7. Connection Not Found Tests"
echo "======================================"

if [ -n "$API_KEY" ]; then
    FAKE_UUID="00000000-0000-0000-0000-000000000000"
    
    test_endpoint "GET" "/api/v1/oauth/connections/$FAKE_UUID" \
        "Get non-existent connection (UUID format)" \
        "" \
        "404" \
        "CONNECTION_NOT_FOUND"
    
    test_endpoint "GET" "/api/v1/oauth/connections/$FAKE_UUID/token" \
        "Get token for non-existent connection" \
        "" \
        "404" \
        "CONNECTION_NOT_FOUND"
    
    test_endpoint "DELETE" "/api/v1/oauth/connections/$FAKE_UUID" \
        "Delete non-existent connection" \
        "" \
        "404" \
        ""
    
    test_endpoint "GET" "/api/v1/oauth/connections/invalid-format" \
        "Get connection with invalid ID format" \
        "" \
        "404" \
        "CONNECTION_NOT_FOUND"
    
    test_endpoint "GET" "/api/v1/oauth/connections/twitter:fake-org-id" \
        "Get connection with secrets-style ID (wrong org)" \
        "" \
        "404" \
        ""
else
    skip_test "Connection not found tests" "No API_KEY provided"
fi

echo ""
echo "======================================"
echo "  8. Error Response Format"
echo "======================================"

if [ -n "$API_KEY" ]; then
    echo -e "\n${BLUE}Testing error response structure...${NC}"
    
    response=$(curl -s "$BASE_URL/api/v1/oauth/token/invalid_platform" \
        -H "Authorization: Bearer $API_KEY")
    
    # Check that error response has all expected fields
    if echo "$response" | grep -q '"error"' && \
       echo "$response" | grep -q '"code"' && \
       echo "$response" | grep -q '"message"' && \
       echo "$response" | grep -q '"reconnectRequired"'; then
        echo -e "  ${GREEN}✓ Error response has all expected fields${NC}"
        ((TESTS_PASSED++))
    else
        echo -e "  ${RED}✗ Error response missing expected fields${NC}"
        echo "  Response: $response"
        ((TESTS_FAILED++))
    fi
else
    skip_test "Error response format tests" "No API_KEY provided"
fi

echo ""
echo "======================================"
echo "  9. Security Tests"
echo "======================================"

test_endpoint "GET" "/api/v1/oauth/connections/../../../etc/passwd" \
    "Path traversal attempt in connection ID" \
    "" \
    "404" \
    ""

if [ -n "$API_KEY" ]; then
    test_endpoint "GET" "/api/v1/oauth/connections/null" \
        "Null injection attempt" \
        "" \
        "404" \
        ""
    
    test_endpoint "GET" "/api/v1/oauth/connections/undefined" \
        "Undefined injection attempt" \
        "" \
        "404" \
        ""
fi

echo ""
echo "======================================"
echo "  Test Summary"
echo "======================================"
echo ""
echo -e "  ${GREEN}Passed: $TESTS_PASSED${NC}"
echo -e "  ${RED}Failed: $TESTS_FAILED${NC}"
echo -e "  ${YELLOW}Skipped: $TESTS_SKIPPED${NC}"
echo ""

TOTAL=$((TESTS_PASSED + TESTS_FAILED))
if [ $TOTAL -gt 0 ]; then
    PERCENT=$((TESTS_PASSED * 100 / TOTAL))
    echo "  Pass Rate: $PERCENT%"
fi

echo ""
echo "======================================"
echo "  Full OAuth Flow Testing Instructions"
echo "======================================"
echo ""
echo "To test the complete Google OAuth flow:"
echo ""
echo "1. Get the auth URL:"
echo "   curl -X POST $BASE_URL/api/v1/oauth/connect \\"
echo "     -H 'Authorization: Bearer YOUR_API_KEY' \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"platform\": \"google\"}'"
echo ""
echo "2. Open the authUrl in a browser and complete Google sign-in"
echo ""
echo "3. After redirect, list connections:"
echo "   curl $BASE_URL/api/v1/oauth/connections \\"
echo "     -H 'Authorization: Bearer YOUR_API_KEY'"
echo ""
echo "4. Get a token by connection ID:"
echo "   curl $BASE_URL/api/v1/oauth/connections/CONNECTION_ID/token \\"
echo "     -H 'Authorization: Bearer YOUR_API_KEY'"
echo ""
echo "5. Or get a token by platform (uses most recent connection):"
echo "   curl $BASE_URL/api/v1/oauth/token/google \\"
echo "     -H 'Authorization: Bearer YOUR_API_KEY'"
echo ""
echo "6. Test caching (second request should have fromCache=true):"
echo "   curl $BASE_URL/api/v1/oauth/token/google \\"
echo "     -H 'Authorization: Bearer YOUR_API_KEY'"
echo ""
echo "7. Revoke the connection:"
echo "   curl -X DELETE $BASE_URL/api/v1/oauth/connections/CONNECTION_ID \\"
echo "     -H 'Authorization: Bearer YOUR_API_KEY'"
echo ""
echo "======================================"
echo "  Done!"
echo "======================================"

# Exit with error if any tests failed
if [ $TESTS_FAILED -gt 0 ]; then
    exit 1
fi
