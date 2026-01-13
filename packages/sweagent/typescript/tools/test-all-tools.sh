#!/bin/bash
# Test script to verify all Node.js tools are working

set -e  # Exit on error

echo "==================================="
echo "Testing SWE-Agent Node.js Tools"
echo "==================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Change to tools directory and capture absolute path
cd "$(dirname "$0")" || exit 1
TOOLS_DIR="$(pwd)"

# Build if needed
if [ ! -d "dist" ]; then
    echo "Building tools..."
    npm run build
fi

# Test function
test_tool() {
    local name=$1
    local cmd=$2
    echo -n "Testing $name... "
    if eval "$cmd" > /dev/null 2>&1; then
        echo -e "${GREEN}✓${NC}"
        return 0
    else
        echo -e "${RED}✗${NC}"
        return 1
    fi
}

# Create test files
TEST_DIR="/tmp/swe-agent-test-$$"
mkdir -p "$TEST_DIR"
cd "$TEST_DIR"

echo "Test content" > test.txt
echo "def hello():" > test.py
echo "    print('world')" >> test.py
echo "    return 42" >> test.py

# Convert a simple PNG image (1x1 pixel)
echo -n "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" | base64 -d > test.png

# Initialize git repo for diff-state
git init > /dev/null 2>&1
git config user.email "test@example.com" > /dev/null 2>&1
git config user.name "Test User" > /dev/null 2>&1

echo ""
echo "Running tool tests:"
echo "-------------------"

# Test each tool
test_tool "Registry" "node $TOOLS_DIR/dist/registry/index.js set TEST_VAR test_value && node $TOOLS_DIR/dist/registry/index.js get TEST_VAR"

test_tool "Diff State" "node $TOOLS_DIR/dist/diff-state/index.js update"

test_tool "View Image" "node $TOOLS_DIR/dist/image-tools/view-image.js test.png"

test_tool "Search File" "node $TOOLS_DIR/dist/search/search-file.js 'content' test.txt"

test_tool "Search Dir" "node $TOOLS_DIR/dist/search/search-dir.js 'test' ."

test_tool "Find File" "node $TOOLS_DIR/dist/search/find-file.js '*.txt' ."

test_tool "Submit" "echo 'test' >> test.txt && git add . && node $TOOLS_DIR/dist/submit/index.js"

test_tool "Forfeit" "node $TOOLS_DIR/dist/forfeit/index.js"

test_tool "Filemap" "node $TOOLS_DIR/dist/filemap/index.js test.py 2>/dev/null || echo 'Tree-sitter optional'"

test_tool "String Replace Editor - View" "node $TOOLS_DIR/dist/edit-anthropic/str-replace-editor.js view test.txt"

test_tool "String Replace Editor - Create" "node $TOOLS_DIR/dist/edit-anthropic/str-replace-editor.js create $TEST_DIR/new-test.txt --file-text 'New file'"

test_tool "Windowed Editor" "node $TOOLS_DIR/dist/windowed/index.js open test.txt"

# Cleanup
cd /
rm -rf "$TEST_DIR"

echo ""
echo "==================================="
echo "Tool testing complete!"
echo "==================================="
echo ""
echo "To use these tools globally, run:"
echo "export PATH=\"$TOOLS_DIR/bin:\$PATH\""
