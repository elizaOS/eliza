#!/bin/bash

# Complete setup and test script for plugin scenarios

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=========================================="
echo "Eliza Plugin Scenario Setup & Test"
echo "==========================================${NC}"

# Check if API key is provided
if [ -z "$1" ]; then
    echo -e "${RED}Error: Please provide your OpenAI API key${NC}"
    echo "Usage: ./setup-and-test-scenarios.sh sk-your-api-key [github-token]"
    exit 1
fi

export OPENAI_API_KEY="$1"
echo -e "${GREEN}✓ OpenAI API key set${NC}"

# Set GitHub token if provided
if [ ! -z "$2" ]; then
    export GITHUB_TOKEN="$2"
    echo -e "${GREEN}✓ GitHub token set${NC}"
fi

# Step 1: Build necessary plugins
echo ""
echo -e "${YELLOW}Step 1: Building required plugins...${NC}"

# Build research plugin
echo "Building research plugin..."
cd ../plugin-research
npm run build
cd ../cli

# Build knowledge plugin  
echo "Building knowledge plugin..."
cd ../plugin-knowledge
npm run build
cd ../cli

# Build other plugins if needed for later scenarios
# echo "Building GitHub plugin..."
# cd ../plugin-github
# npm run build
# cd ../cli

echo -e "${GREEN}✓ Plugins built successfully${NC}"

# Step 2: Build the CLI
echo ""
echo -e "${YELLOW}Step 2: Building the CLI...${NC}"
npm run build
echo -e "${GREEN}✓ CLI built successfully${NC}"

# Step 3: Clean up any previous test database
echo ""
echo -e "${YELLOW}Step 3: Cleaning up test environment...${NC}"
rm -rf .scenario-test-db
rm -f scenario-results.json
echo -e "${GREEN}✓ Test environment cleaned${NC}"

# Step 4: Run the first scenario
echo ""
echo -e "${YELLOW}Step 4: Running Research Knowledge Integration scenario...${NC}"
echo ""

npx elizaos scenario --scenario ./scenarios/plugin-tests/01-research-knowledge-integration.ts --verbose

# Check if it passed
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Research Knowledge Integration scenario PASSED!${NC}"
    
    # Ask if user wants to continue with other scenarios
    echo ""
    read -p "Do you want to run more scenarios? (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        ./test-all-scenarios.sh "$1" "$2"
    fi
else
    echo -e "${RED}✗ Research Knowledge Integration scenario FAILED${NC}"
    echo ""
    echo -e "${YELLOW}Debugging tips:${NC}"
    echo "1. Check that your OpenAI API key is valid"
    echo "2. Look for 'mock response' in the output - this indicates the API isn't being called"
    echo "3. Check for 'Actions: 0' - this means no plugin actions were executed"
    echo "4. Review the scenario-results.json file for detailed results"
    echo ""
    echo "To see detailed results:"
    echo "  cat scenario-results.json | jq ."
fi

echo ""
echo -e "${BLUE}=========================================="
echo "Setup and test complete!"
echo "==========================================${NC}" 