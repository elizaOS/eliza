#!/bin/bash

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}🚀 Running Quick Test Suite${NC}"
echo "========================="

# Track if any test fails
FAILED=0

# 1. Type Checking
echo -e "\n${YELLOW}📝 Running TypeScript Type Checking...${NC}"
./scripts/check-types.sh
if [ $? -ne 0 ]; then
  echo -e "${RED}❌ Type checking failed${NC}"
  FAILED=1
else
  echo -e "${GREEN}✅ Type checking passed${NC}"
fi

# 2. Vitest Unit Tests
echo -e "\n${YELLOW}🧪 Running Vitest Unit Tests...${NC}"
npm run test:unit
if [ $? -ne 0 ]; then
  echo -e "${RED}❌ Vitest tests failed${NC}"
  FAILED=1
else
  echo -e "${GREEN}✅ Vitest tests passed${NC}"
fi

# Summary
echo -e "\n========================="
if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}✅ All tests passed!${NC}"
  exit 0
else
  echo -e "${RED}❌ Some tests failed!${NC}"
  exit 1
fi 