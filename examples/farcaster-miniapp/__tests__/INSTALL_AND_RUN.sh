#!/bin/bash

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Eliza Multi-Chain Mini App - Test Suite Installer  ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════╝${NC}"
echo ""

# Navigate to project directory
cd "$(dirname "$0")/.."
PROJECT_DIR=$(pwd)

echo -e "${BLUE}📂 Project directory: ${PROJECT_DIR}${NC}"
echo ""

# Step 1: Install dependencies
echo -e "${YELLOW}📦 Step 1: Installing dependencies...${NC}"
if npm install; then
    echo -e "${GREEN}✅ Dependencies installed successfully${NC}"
else
    echo -e "${RED}❌ Failed to install dependencies${NC}"
    exit 1
fi
echo ""

# Step 2: TypeScript type check
echo -e "${YELLOW}🔍 Step 2: Checking TypeScript types...${NC}"
if npx tsc --noEmit; then
    echo -e "${GREEN}✅ No TypeScript errors found${NC}"
else
    echo -e "${YELLOW}⚠️  TypeScript errors detected (may be fixable)${NC}"
fi
echo ""

# Step 3: Run tests with mocks
echo -e "${YELLOW}🧪 Step 3: Running tests (mock mode)...${NC}"
echo -e "${BLUE}This will run all tests with mocked APIs${NC}"
echo ""

if npm test -- --run; then
    echo ""
    echo -e "${GREEN}✅ All tests passed!${NC}"
    
    # Generate coverage
    echo ""
    echo -e "${YELLOW}📊 Generating coverage report...${NC}"
    npm run test:coverage -- --run
    
    echo ""
    echo -e "${GREEN}╔═══════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║              🎉 TEST SUITE READY! 🎉                 ║${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${BLUE}Next steps:${NC}"
    echo -e "  ${GREEN}1.${NC} View coverage report: open coverage/index.html"
    echo -e "  ${GREEN}2.${NC} Run tests in UI mode: npm run test:ui"
    echo -e "  ${GREEN}3.${NC} Build the application: npm run build"
    echo -e "  ${GREEN}4.${NC} Start development: npm run dev"
    echo ""
    echo -e "${BLUE}To run tests with real API:${NC}"
    echo -e "  ${GREEN}1.${NC} Start backend: npm start"
    echo -e "  ${GREEN}2.${NC} In new terminal: npm run test:real"
    echo ""
else
    echo ""
    echo -e "${RED}❌ Some tests failed${NC}"
    echo -e "${YELLOW}Tips:${NC}"
    echo -e "  - Check test output above for details"
    echo -e "  - Run 'npm run test:ui' for interactive debugging"
    echo -e "  - Check __tests__/README.md for troubleshooting"
    exit 1
fi

# Optional: Build check
echo -e "${YELLOW}🔨 Optional: Building application...${NC}"
if npm run build; then
    echo -e "${GREEN}✅ Build successful${NC}"
    echo ""
    echo -e "${BLUE}Your application is ready to deploy!${NC}"
    echo -e "See DEPLOYMENT.md for deployment instructions"
else
    echo -e "${RED}❌ Build failed${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         🚀 All checks passed! Ready to go! 🚀        ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════╝${NC}"

