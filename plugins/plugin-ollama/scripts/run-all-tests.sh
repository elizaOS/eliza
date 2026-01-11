#!/bin/bash
# Run all tests for the Ollama plugin (TypeScript, Python, Rust)

set -e

echo "=== Running TypeScript Tests ==="
bun test

echo ""
echo "=== Running Python Tests ==="
cd python
python -m pytest tests/ -v
cd ..

echo ""
echo "=== Running Rust Tests ==="
cd rust
cargo test
cd ..

echo ""
echo "=== All tests passed! ==="







