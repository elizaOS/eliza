#!/bin/bash

# Test script for scenario runner

echo "🧪 Testing Scenario Runner..."

# Build the project first
echo "📦 Building project..."
bun run build

# Test loading a single scenario
echo -e "\n📋 Testing single scenario load..."
bun run eliza scenario run -s scenarios/plugin-tests/01-research-knowledge-integration.ts -v

# Test running all plugin test scenarios
echo -e "\n🎯 Testing all plugin scenarios..."
bun run eliza scenario run -d scenarios/plugin-tests -v

# Test specific scenarios
echo -e "\n🔍 Testing specific scenarios..."
for scenario in 01-research-knowledge-integration.ts 02-github-todo-workflow.ts 03-planning-execution.ts; do
  echo -e "\n  Testing: $scenario"
  bun run eliza scenario run -s "scenarios/plugin-tests/$scenario"
done

echo -e "\n✅ Scenario testing complete!" 