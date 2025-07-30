#!/bin/bash

# Exit on error
set -e

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Starting comprehensive test suite for project-tee-starter...${NC}"

# Function to run tests and capture results
run_test() {
    local test_name=$1
    local test_command=$2
    
    echo -e "\n${BLUE}Running ${test_name}...${NC}"
    
    if eval "$test_command"; then
        echo -e "${GREEN}✓ ${test_name} passed${NC}"
        return 0
    else
        echo -e "${RED}✗ ${test_name} failed${NC}"
        return 1
    fi
}

# Track overall success
all_passed=true

# 1. Type checking
if ! run_test "TypeScript type checking" "bun run type-check"; then
    all_passed=false
fi

# 2. Build test
if ! run_test "Build process" "bun run build"; then
    all_passed=false
    echo -e "${RED}Build failed, skipping further tests${NC}"
    exit 1
fi

# 3. Unit tests
if ! run_test "Unit tests" "bun test"; then
    all_passed=false
fi

# 4. E2E tests (if server is running)
if lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null; then
    if ! run_test "E2E tests" "elizaos test e2e"; then
        all_passed=false
    fi
else
    echo -e "${BLUE}Skipping E2E tests (server not running on port 3000)${NC}"
fi

# 5. Component tests with bun test
if ! run_test "Component tests" "bun test __tests__/frontend.test.ts"; then
    all_passed=false
fi

# 6. Build validation
if ! run_test "Build output validation" "test -f dist/src/index.js && test -f dist/index.d.ts"; then
    all_passed=false
fi

# 7. Frontend build validation
if ! run_test "Frontend build validation" "test -f dist/frontend/index.html"; then
    all_passed=false
fi

# Final report
echo -e "\n${BLUE}========================================${NC}"
if [ "$all_passed" = true ]; then
    echo -e "${GREEN}All tests passed! 🎉${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed. Please review the output above.${NC}"
    exit 1
fi 