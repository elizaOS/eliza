#!/bin/bash

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}🌐 Starting E2E Tests with Backend + Dev Server${NC}"
echo "===================================="

# Ensure cleanup on exit
cleanup() {
  echo -e "\n${YELLOW}Stopping servers...${NC}"
  if [ -n "$APP_PID" ]; then kill $APP_PID 2>/dev/null; fi
  if [ -n "$API_PID" ]; then kill $API_PID 2>/dev/null; fi
}
trap cleanup EXIT

# Start the backend API server (elizaos) in the background
echo -e "${YELLOW}Starting backend server...${NC}"
API_PORT=${API_PORT:-3000}
# Use in-memory PGLite database for E2E tests to avoid file system issues
export PGLITE_DATA_DIR="memory://"
export ELIZA_NONINTERACTIVE=true
export LOG_LEVEL=${LOG_LEVEL:-error}

# Run the CLI server from the monorepo dist
(cd ../.. && bun packages/cli/dist/index.js start) &
API_PID=$!

# Wait for backend API to be ready
echo -e "${YELLOW}Waiting for backend server to be ready on :$API_PORT...${NC}"
bunx wait-on tcp:$API_PORT -t 120000

if [ $? -ne 0 ]; then
  echo -e "${RED}❌ Failed to start backend server${NC}"
  kill $API_PID 2>/dev/null
  exit 1
fi

echo -e "${GREEN}✅ Backend server is ready${NC}"

# Start the dev server in the background
echo -e "${YELLOW}Starting development server...${NC}"
CLIENT_PORT=${CLIENT_PORT:-5173}
bunx vite --port $CLIENT_PORT &
APP_PID=$!

# Wait for dev server to be ready
echo -e "${YELLOW}Waiting for dev server to be ready...${NC}"
bunx wait-on http://localhost:$CLIENT_PORT -t 60000

if [ $? -ne 0 ]; then
  echo -e "${RED}❌ Failed to start development server${NC}"
  kill $APP_PID 2>/dev/null
  exit 1
fi

echo -e "${GREEN}✅ Development server is ready${NC}"

# Run E2E tests
echo -e "\n${YELLOW}Running E2E tests...${NC}"
bunx cypress run --e2e
TEST_EXIT_CODE=$?

# Cleanup is handled by trap

# Exit with test exit code
if [ $TEST_EXIT_CODE -eq 0 ]; then
  echo -e "${GREEN}✅ E2E tests passed!${NC}"
  exit 0
else
  echo -e "${RED}❌ E2E tests failed!${NC}"
  exit 1
fi 