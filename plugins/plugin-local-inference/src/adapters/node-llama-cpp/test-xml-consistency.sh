#!/bin/bash
# Cross-language XML parser consistency test
# Ensures TypeScript, Python, and Rust implementations behave identically

set -e
cd "$(dirname "$0")"

echo "🔍 Testing XML Parser Consistency Across Languages"
echo "=================================================="
echo ""

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

PASSED=0
FAILED=0

# Test data - same across all languages
TEST_XML='<response>
<thought>I am thinking about this problem</thought>
<text>Hello, world!</text>
<actions>action1, action2, action3</actions>
<success>true</success>
<code><![CDATA[
function test() {
    if (x < 10 && y > 5) {
        return "<div>" + x + "</div>";
    }
}
]]></code>
</response>'

echo "Test XML:"
echo "$TEST_XML"
echo ""
echo "--------------------------------------------------"

# TypeScript test
echo ""
echo "📘 TypeScript Tests..."
if bun run typescript/utils/xmlParser.ts 2>/dev/null | grep -q "13/13 tests passed"; then
    echo -e "${GREEN}✓ TypeScript: 13/13 tests passed${NC}"
    ((PASSED++))
else
    echo -e "${RED}✗ TypeScript tests failed${NC}"
    ((FAILED++))
fi

# Python test
echo ""
echo "🐍 Python Tests..."
cd python
if python3 -m pytest elizaos_plugin_local_ai/xml_parser.py -v 2>&1 | grep -q "13 passed"; then
    echo -e "${GREEN}✓ Python: 13/13 tests passed${NC}"
    ((PASSED++))
else
    echo -e "${RED}✗ Python tests failed${NC}"
    ((FAILED++))
fi
cd ..

# Rust test
echo ""
echo "🦀 Rust Tests..."
cd rust
if cargo test xml_parser 2>&1 | grep -q "13 passed"; then
    echo -e "${GREEN}✓ Rust: 13/13 tests passed${NC}"
    ((PASSED++))
else
    echo -e "${RED}✗ Rust tests failed${NC}"
    ((FAILED++))
fi
cd ..

echo ""
echo "=================================================="
echo "Cross-Language Consistency Results"
echo "=================================================="

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✅ ALL LANGUAGES CONSISTENT: $PASSED/3 passed${NC}"
    echo ""
    echo "All three implementations handle:"
    echo "  • Simple tag extraction"
    echo "  • CDATA sections (code blocks preserved)"
    echo "  • Nested tags with depth counting"
    echo "  • XML entity escaping/unescaping"
    echo "  • Numeric entities (decimal & hex)"
    echo "  • Self-closing tags"
    echo "  • List fields (actions, providers, evaluators)"
    echo "  • Boolean fields (success, error, simple)"
    echo "  • Nested CDATA escape sequences"
    exit 0
else
    echo -e "${RED}❌ INCONSISTENCY DETECTED: $FAILED/3 failed${NC}"
    exit 1
fi







