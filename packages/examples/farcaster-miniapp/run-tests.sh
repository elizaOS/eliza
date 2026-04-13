#!/bin/bash

# Multi-Chain Mini App Test Runner
# This script installs dependencies and runs all tests

set -e  # Exit on error

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     Eliza Multi-Chain Mini App - Test Runner        ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════╝${NC}"
echo ""

# Navigate to project directory
cd "$(dirname "$0")"
PROJECT_DIR=$(pwd)

echo -e "${BLUE}📂 Project: ${PROJECT_DIR}${NC}"
echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}📦 Installing dependencies...${NC}"
    npm install
    echo -e "${GREEN}✅ Dependencies installed${NC}"
    echo ""
else
    echo -e "${GREEN}✅ Dependencies already installed${NC}"
    echo ""
fi

# Run TypeScript check
echo -e "${BLUE}🔍 Checking TypeScript types...${NC}"
npx tsc --noEmit --skipLibCheck 2>&1 | head -20 || echo -e "${YELLOW}⚠️  Some TypeScript warnings (non-critical)${NC}"
echo ""

# Run tests with mocks (default)
echo -e "${BLUE}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║              Running Tests (Mock Mode)               ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════╝${NC}"
echo ""

# Run vitest
npm test -- --run --reporter=verbose 2>&1

TEST_EXIT_CODE=$?

echo ""
if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║              ✅ ALL TESTS PASSED! ✅                  ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
    echo ""
    
    # Generate coverage
    echo -e "${BLUE}📊 Generating coverage report...${NC}"
    npm run test:coverage -- --run 2>&1 || echo -e "${YELLOW}Coverage generation skipped${NC}"
    
    echo ""
    echo -e "${GREEN}🎉 Test suite complete!${NC}"
    echo ""
    echo -e "${BLUE}Next steps:${NC}"
    echo -e "  • View coverage: ${YELLOW}open coverage/index.html${NC}"
    echo -e "  • Build app: ${YELLOW}npm run build${NC}"
    echo -e "  • Start dev: ${YELLOW}npm run dev${NC}"
else
    echo -e "${RED}╔══════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║              ❌ SOME TESTS FAILED ❌                  ║${NC}"
    echo -e "${RED}╚══════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${YELLOW}Troubleshooting:${NC}"
    echo -e "  • Run in UI mode: ${YELLOW}npm run test:ui${NC}"
    echo -e "  • Check logs above for details"
    echo -e "  • See __tests__/README.md for help"
    exit 1
fi

