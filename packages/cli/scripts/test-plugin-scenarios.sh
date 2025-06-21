#!/bin/bash

# Test plugin scenarios one by one using elizaos scenario command

echo "Building the CLI..."
cd ../..
npm run build:cli
cd packages/cli

echo ""
echo "Testing Research Knowledge Integration Scenario..."
echo "================================================"
npx elizaos scenario -s ./scenarios/plugin-tests/01-research-knowledge-integration.ts -v

# Uncomment the lines below to test additional scenarios after confirming the first one works
# echo ""
# echo "Testing GitHub Todo Workflow Scenario..."
# echo "======================================"
# npx elizaos scenario -s ./scenarios/plugin-tests/02-github-todo-workflow.ts -v

# echo ""
# echo "Testing Planning Execution Scenario..."
# echo "===================================="
# npx elizaos scenario -s ./scenarios/plugin-tests/03-planning-execution.ts -v

# echo ""
# echo "Testing Rolodex Relationship Management Scenario..."
# echo "================================================"
# npx elizaos scenario -s ./scenarios/plugin-tests/04-rolodex-relationship-management.ts -v

# echo ""
# echo "Testing Stagehand Web Research Scenario..."
# echo "========================================"
# npx elizaos scenario -s ./scenarios/plugin-tests/05-stagehand-web-research.ts -v 