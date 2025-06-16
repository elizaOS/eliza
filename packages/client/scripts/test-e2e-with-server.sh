#!/bin/bash

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}🌐 Starting E2E Tests with Dev Server${NC}"
echo "===================================="

# Start the dev server in the background
echo -e "${YELLOW}Starting development server...${NC}"
CLIENT_PORT=${CLIENT_PORT:-5173}
bunx vite --port $CLIENT_PORT &
SERVER_PID=$!

# Wait for server to be ready
echo -e "${YELLOW}Waiting for server to be ready...${NC}"
bunx wait-on http://localhost:$CLIENT_PORT -t 30000

if [ $? -ne 0 ]; then
  echo -e "${RED}❌ Failed to start development server${NC}"
  kill $SERVER_PID 2>/dev/null
  exit 1
fi

echo -e "${GREEN}✅ Development server is ready${NC}"

# Run E2E tests
echo -e "\n${YELLOW}Running E2E tests...${NC}"
bunx cypress run --e2e
TEST_EXIT_CODE=$?

# Kill the server
echo -e "\n${YELLOW}Stopping development server...${NC}"
kill $SERVER_PID 2>/dev/null

# Exit with test exit code
if [ $TEST_EXIT_CODE -eq 0 ]; then
  echo -e "${GREEN}✅ E2E tests passed!${NC}"
  exit 0
else
  echo -e "${RED}❌ E2E tests failed!${NC}"
  exit 1
fi 