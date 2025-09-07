#!/bin/bash
# run_all_bats.sh - Production validation test runner for XMRT-Eliza
# This script runs BATS tests for production validation as expected by the CI/CD pipeline

set -e

# Set test environment variables
export ELIZA_TEST_MODE="true"
export NODE_ENV="test"
export IS_NPM_TEST="true"

echo "🧪 Running XMRT-Eliza Production Validation Tests"
echo "================================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test results
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# Function to run test suite
run_test_suite() {
  local suite_name="$1"
  local test_path="$2"
  local description="$3"

  echo -e "\n${BLUE}Running ${suite_name}...${NC}"
  echo -e "${YELLOW}${description}${NC}"

  if bats "$test_path"; then
    echo -e "${GREEN}✓ ${suite_name} passed${NC}"
    ((PASSED_TESTS++))
  else
    echo -e "${RED}✗ ${suite_name} failed${NC}"
    ((FAILED_TESTS++))
  fi
  ((TOTAL_TESTS++))
}

# Change to the CLI source directory where test scripts are located
cd "$(dirname "$0")/../src/__test_scripts__"

# Check if BATS is available
if ! command -v bats >/dev/null 2>&1; then
  echo -e "${RED}Error: BATS is not installed${NC}"
  echo "BATS should have been installed globally in the CI pipeline"
  exit 1
fi

# Verify elizaos global command is available
if ! command -v elizaos >/dev/null 2>&1; then
  echo -e "${RED}Error: elizaos global command not found${NC}"
  echo "elizaos CLI should have been installed globally in the CI pipeline"
  exit 1
fi

echo -e "${GREEN}✓ elizaos CLI version: $(elizaos --version)${NC}"

# Run test suites in order of importance
echo -e "\n${YELLOW}=== AUTONOMOUS SYSTEMS VALIDATION ===${NC}"

# Test 1: Command functionality tests
if [ -d "commands" ]; then
  run_test_suite "Command Tests" "commands" "Testing core CLI commands and functionality"
fi

# Test 2: Integration tests for autonomous coordination
if [ -d "integration" ]; then
  run_test_suite "Integration Tests" "integration" "Testing autonomous agent coordination and communication"
fi

# Test 3: End-to-end workflow tests
if [ -d "e2e" ]; then
  run_test_suite "E2E Workflow Tests" "e2e" "Testing complete autonomous system workflows"
fi

# Test 4: Additional test files in root
for test_file in *.bats; do
  if [ -f "$test_file" ]; then
    run_test_suite "$(basename "$test_file" .bats)" "$test_file" "Testing $(basename "$test_file" .bats) functionality"
  fi
done

# Autonomous Systems Health Check
echo -e "\n${YELLOW}=== AUTONOMOUS SYSTEMS HEALTH CHECK ===${NC}"

# Check Redis availability (critical for autonomous memory)
if command -v redis-cli >/dev/null 2>&1; then
  if redis-cli ping >/dev/null 2>&1; then
    echo -e "${GREEN}✓ Redis (agent memory) is available${NC}"
  else
    echo -e "${YELLOW}⚠ Redis not running - autonomous memory may be limited${NC}"
  fi
else
  echo -e "${YELLOW}⚠ Redis not installed - autonomous memory will use fallback${NC}"
fi

# Check for required environment variables
required_vars=("OPENAI_API_KEY")
for var in "${required_vars[@]}"; do
  if [ -n "${!var}" ]; then
    echo -e "${GREEN}✓ $var is configured${NC}"
  else
    echo -e "${YELLOW}⚠ $var not set - some autonomous features may be limited${NC}"
  fi
done

# Summary
echo -e "\n================================================="
echo -e "Production Validation Summary:"
echo -e "Total Test Suites: ${TOTAL_TESTS}"
echo -e "${GREEN}Passed: ${PASSED_TESTS}${NC}"
echo -e "${RED}Failed: ${FAILED_TESTS}${NC}"

if [[ $FAILED_TESTS -eq 0 ]]; then
  echo -e "\n${GREEN}✅ All production validation tests passed!${NC}"
  echo -e "${GREEN}XMRT-Eliza autonomous systems are ready for production${NC}"
  exit 0
else
  echo -e "\n${RED}❌ Some production validation tests failed!${NC}"
  echo -e "${RED}Autonomous systems may not function correctly${NC}"
  exit 1
fi

