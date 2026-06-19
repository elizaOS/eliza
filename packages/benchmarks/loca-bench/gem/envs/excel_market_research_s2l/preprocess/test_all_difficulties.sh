#!/bin/bash

# Test script for all difficulty levels
# This script tests data generation for all difficulty presets

echo "============================================================"
echo "Testing Excel Market Research Data Generator"
echo "============================================================"
echo ""

TASK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$TASK_ROOT"

FAILURES=0
SUCCESSES=0

test_difficulty() {
    local difficulty=$1
    local seed=$2
    
    echo "------------------------------------------------------------"
    echo "Testing difficulty: $difficulty (seed=$seed)"
    echo "------------------------------------------------------------"
    
    python3 preprocess/main.py --difficulty "$difficulty" --seed "$seed"
    
    if [ $? -eq 0 ]; then
        echo "✅ $difficulty: SUCCESS"
        ((SUCCESSES++))
    else
        echo "❌ $difficulty: FAILED"
        ((FAILURES++))
    fi
    echo ""
}

# Test all difficulty levels with different seeds
test_difficulty "easy" 100
test_difficulty "medium" 200
test_difficulty "hard" 300
test_difficulty "expert" 400

# Summary
echo "============================================================"
echo "Test Summary"
echo "============================================================"
echo "Successes: $SUCCESSES"
echo "Failures: $FAILURES"
echo ""

if [ $FAILURES -eq 0 ]; then
    echo "🎉 All tests passed!"
    exit 0
else
    echo "❌ Some tests failed"
    exit 1
fi

