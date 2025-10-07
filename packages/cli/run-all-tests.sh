#!/bin/bash
# run-all-tests.sh

set -e

# Set test environment variables
export ELIZA_TEST_MODE="true"
export NODE_ENV="test"

echo "🧪 Running elizaOS CLI Test Suite"
echo "================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test results
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# Detect macOS and adjust settings
if [[ "$OSTYPE" == "darwin"* ]] || [[ "$(uname)" == "Darwin" ]]; then
  echo -e "${YELLOW}macOS detected - using optimized settings${NC}"
  TIMEOUT=240000    # 4 minutes instead of 2
  CONCURRENCY=1     # No concurrency on macOS
  MEMORY=8192       # 8GB instead of 4GB
else
  TIMEOUT=120000
  CONCURRENCY=2
  MEMORY=4096
fi

# Function to run test suite
run_test_suite() {
  local suite_name="$1"
  local test_command="$2"

  echo -e "\n${YELLOW}Running ${suite_name}...${NC}"

  if eval "$test_command"; then
    echo -e "${GREEN}✓ ${suite_name} passed${NC}"
    ((PASSED_TESTS++))
  else
    echo -e "${RED}✗ ${suite_name} failed${NC}"
    ((FAILED_TESTS++))
  fi
  ((TOTAL_TESTS++))
}

# Change to CLI directory
cd "$(dirname "$0")"

# Build the CLI first
echo "Building CLI..."
bun run build

# Run TypeScript checks
# Skip TypeScript validation due to dependency type issues
echo -e "${YELLOW}⚠ Skipping TypeScript validation due to dependency type issues${NC}"
# run_test_suite "TypeScript Validation" "tsc --noEmit"

# Run unit tests - disable coverage in CI due to memory constraints
if [ "$CI" = "true" ]; then
  echo -e "${YELLOW}Running tests without coverage in CI to avoid memory issues${NC}"
  run_test_suite "Unit Tests" "cross-env NODE_OPTIONS=\"--max-old-space-size=${MEMORY}\" bun test tests/commands --timeout ${TIMEOUT} --concurrency ${CONCURRENCY}"
else
  # Run with coverage locally
  run_test_suite "Unit Tests" "bun test tests/commands --coverage --timeout 60000"
fi

# Run BATS tests if available
if command -v bats >/dev/null 2>&1; then
  run_test_suite "BATS Command Tests" "bats tests/bats/commands"
  run_test_suite "BATS Integration Tests" "bats tests/bats/integration"
  run_test_suite "BATS E2E Tests" "bats tests/bats/e2e"
else
  echo -e "${YELLOW}⚠ BATS not installed, skipping integration tests${NC}"
  echo "Install BATS with: brew install bats-core (macOS) or apt-get install bats (Linux)"
fi

# Test global installation
echo -e "\n${YELLOW}Testing global installation...${NC}"
npm pack > /dev/null 2>&1
PACKAGE_FILE=$(ls elizaos-cli-*.tgz | head -n 1)
if [[ -n "$PACKAGE_FILE" ]]; then
  run_test_suite "Global Install Test" "npm install -g ./$PACKAGE_FILE && elizaos --version && npm uninstall -g @elizaos/cli"
  rm -f "$PACKAGE_FILE"
fi

# Summary
echo -e "\n================================="
echo -e "Test Summary:"
echo -e "Total: ${TOTAL_TESTS}"
echo -e "${GREEN}Passed: ${PASSED_TESTS}${NC}"
echo -e "${RED}Failed: ${FAILED_TESTS}${NC}"

if [[ $FAILED_TESTS -eq 0 ]]; then
  echo -e "\n${GREEN}✓ All tests passed!${NC}"
  exit 0
else
  echo -e "\n${RED}✗ Some tests failed!${NC}"
  exit 1
fi
