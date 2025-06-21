#!/bin/bash

# Exit on error
set -e

echo "Running scenario test with API key..."

# Check if API key is provided as argument
if [ -z "$1" ]; then
    echo "Please provide your OpenAI API key as the first argument:"
    echo "  ./run-scenario-test.sh sk-your-api-key"
    exit 1
fi

# Set the API key
export OPENAI_API_KEY="$1"

# Set GitHub token if provided
if [ ! -z "$2" ]; then
    export GITHUB_TOKEN="$2"
fi

echo "Running research knowledge integration scenario..."
npx elizaos scenario --scenario ./scenarios/plugin-tests/01-research-knowledge-integration.ts --verbose

echo "Test complete!" 