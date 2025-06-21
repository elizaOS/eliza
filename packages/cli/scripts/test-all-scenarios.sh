#!/bin/bash

# Exit on error
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=========================================="
echo "Plugin Scenario Test Runner"
echo "=========================================="

# Check if API key is provided
if [ -z "$1" ]; then
    echo -e "${RED}Error: Please provide your OpenAI API key as the first argument${NC}"
    echo "Usage: ./test-all-scenarios.sh sk-your-api-key [github-token]"
    exit 1
fi

export OPENAI_API_KEY="$1"

# Set GitHub token if provided
if [ ! -z "$2" ]; then
    export GITHUB_TOKEN="$2"
    echo -e "${GREEN}GitHub token set${NC}"
fi

# Function to run a scenario
run_scenario() {
    local scenario_file=$1
    local scenario_name=$2
    
    echo ""
    echo -e "${YELLOW}=========================================="
    echo "Testing: $scenario_name"
    echo "==========================================${NC}"
    
    # Run the scenario
    if npx elizaos scenario --scenario "$scenario_file" --verbose; then
        echo -e "${GREEN}✅ PASSED: $scenario_name${NC}"
        return 0
    else
        echo -e "${RED}❌ FAILED: $scenario_name${NC}"
        return 1
    fi
}

# Keep track of results
TOTAL=0
PASSED=0
FAILED=0

# Test scenarios one by one
echo ""
echo "Starting scenario tests..."

# 01. Research Knowledge Integration
((TOTAL++))
if run_scenario "./scenarios/plugin-tests/01-research-knowledge-integration.ts" "Research Knowledge Integration"; then
    ((PASSED++))
else
    ((FAILED++))
fi

# 02. GitHub Todo Workflow (requires GitHub token)
if [ ! -z "$GITHUB_TOKEN" ]; then
    ((TOTAL++))
    if run_scenario "./scenarios/plugin-tests/02-github-todo-workflow.ts" "GitHub Todo Workflow"; then
        ((PASSED++))
    else
        ((FAILED++))
    fi
else
    echo -e "${YELLOW}⚠️  Skipping GitHub Todo Workflow (no GitHub token provided)${NC}"
fi

# 03. Planning Execution
((TOTAL++))
if run_scenario "./scenarios/plugin-tests/03-planning-execution.ts" "Planning Execution"; then
    ((PASSED++))
else
    ((FAILED++))
fi

# 04. Rolodex Relationship Management
((TOTAL++))
if run_scenario "./scenarios/plugin-tests/04-rolodex-relationship-management.ts" "Rolodex Relationship Management"; then
    ((PASSED++))
else
    ((FAILED++))
fi

# 05. Stagehand Web Research
((TOTAL++))
if run_scenario "./scenarios/plugin-tests/05-stagehand-web-research.ts" "Stagehand Web Research"; then
    ((PASSED++))
else
    ((FAILED++))
fi

# Summary
echo ""
echo "=========================================="
echo "Test Summary"
echo "=========================================="
echo -e "Total: $TOTAL"
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}All tests passed! 🎉${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed. Please check the logs above.${NC}"
    exit 1
fi 