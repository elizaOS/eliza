#!/bin/bash

echo "=========================================="
echo "Installing dependencies..."
echo "=========================================="

# Install pytest for testing
pip3 install --break-system-packages pytest==8.3.4 pytest-json-report==1.5.0 --quiet || true

echo ""
echo "=========================================="
echo "Agent's solution.py:"
echo "=========================================="
cat /root/workspace/solution.py

echo ""
echo "=========================================="
echo "Running tests..."
echo "=========================================="

# Ensure logs directory exists
mkdir -p /logs/verifier

# Run tests - capture exit code but don't exit on failure
set +e
python3 /tests/test_outputs.py
TEST_EXIT_CODE=$?
set -e

# Check if reward.txt was created
if [ -f "/logs/verifier/reward.txt" ]; then
    echo ""
    echo "=========================================="
    echo "Test completed. Score:"
    cat /logs/verifier/reward.txt
    echo "=========================================="
else
    echo ""
    echo "=========================================="
    echo "WARNING: No reward.txt generated"
    echo "Writing default score: 0.0"
    echo "=========================================="
    mkdir -p /logs/verifier
    echo "0.0" > /logs/verifier/reward.txt
fi

exit 0
