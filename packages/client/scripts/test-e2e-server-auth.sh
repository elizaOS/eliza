#!/bin/bash

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}🔐 Starting E2E Tests with Authentication Enabled${NC}"
echo "===================================="

# Define port early for use in cleanup
API_PORT=${API_PORT:-3000}

# Ensure cleanup on exit
cleanup() {
  echo -e "\n${YELLOW}Stopping servers...${NC}"

  # Kill dev server
  if [ -n "$APP_PID" ]; then
    kill -9 $APP_PID 2>/dev/null
    wait $APP_PID 2>/dev/null
  fi

  # Kill API server and wait for it to stop
  if [ -n "$API_PID" ]; then
    kill -9 $API_PID 2>/dev/null
    wait $API_PID 2>/dev/null
    # Also kill any remaining processes on port 3000
    lsof -ti:$API_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
    sleep 1
  fi

  # Stop PostgreSQL container (only if running locally, not in CI)
  if [ "$POSTGRES_STARTED" = "true" ] && [ "$CI" != "true" ]; then
    echo -e "${YELLOW}Stopping PostgreSQL...${NC}"
    docker-compose -f docker-compose.test.yml down -v >/dev/null 2>&1
  fi
}
trap cleanup EXIT

# Setup PostgreSQL (different approach for CI vs local)
if [ "$CI" = "true" ]; then
  # In CI, GitHub Actions services are already running
  echo -e "${YELLOW}Using PostgreSQL service from CI...${NC}"
  # PostgreSQL is already available at localhost:5433
else
  # Locally, start PostgreSQL with docker-compose
  echo -e "${YELLOW}Starting PostgreSQL with docker-compose...${NC}"
  docker-compose -f docker-compose.test.yml up -d

  if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Failed to start PostgreSQL${NC}"
    echo -e "${YELLOW}Make sure Docker is running${NC}"
    exit 1
  fi

  POSTGRES_STARTED=true

  # Wait for PostgreSQL to be healthy
  echo -e "${YELLOW}Waiting for PostgreSQL to be ready...${NC}"
  MAX_RETRIES=30
  RETRY_COUNT=0
  while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if docker-compose -f docker-compose.test.yml exec -T postgres-test pg_isready -U eliza_test >/dev/null 2>&1; then
      echo -e "${GREEN}✅ PostgreSQL is ready${NC}"
      break
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
    echo -e "${YELLOW}Waiting for PostgreSQL... ($RETRY_COUNT/$MAX_RETRIES)${NC}"
    sleep 1
  done

  if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    echo -e "${RED}❌ PostgreSQL failed to start${NC}"
    exit 1
  fi

  # Give PostgreSQL a bit more time to fully initialize
  echo -e "${YELLOW}Giving PostgreSQL extra time to fully initialize...${NC}"
  sleep 3

  # Test the connection with a simple query
  echo -e "${YELLOW}Testing PostgreSQL connection...${NC}"
  if docker-compose -f docker-compose.test.yml exec -T postgres-test psql -U eliza_test -d eliza_test -c "SELECT 1" >/dev/null 2>&1; then
    echo -e "${GREEN}✅ PostgreSQL connection verified${NC}"
  else
    echo -e "${RED}❌ Failed to connect to PostgreSQL${NC}"
    exit 1
  fi
fi

# Start the backend API server with DATA ISOLATION and AUTH enabled
echo -e "${YELLOW}Starting backend server with authentication...${NC}"

# Kill any process using port 3000 to ensure it's available
lsof -ti:$API_PORT | xargs kill -9 2>/dev/null || true

# Use PostgreSQL for data isolation (required for authentication)
export POSTGRES_URL="postgresql://eliza_test:eliza_test_password@localhost:5433/eliza_test"
export ELIZA_NONINTERACTIVE=true
export LOG_LEVEL=${LOG_LEVEL:-error}
# Enable data isolation and authentication for E2E tests
export ENABLE_DATA_ISOLATION=true
export ELIZA_SERVER_ID="test-server-e2e"
export JWT_SECRET="test-jwt-secret-for-e2e-tests-only"
# Force the server to use port 3000 (SERVER_PORT is what AgentServer reads)
export SERVER_PORT=$API_PORT

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

echo -e "${GREEN}✅ Backend server is ready (with authentication enabled)${NC}"

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

# Run E2E tests (all authentication tests in auth/ directory)
echo -e "\n${YELLOW}Running authentication E2E tests...${NC}"
bunx cypress run --e2e --spec "cypress/e2e/auth/**/*.cy.ts"
TEST_EXIT_CODE=$?

# Cleanup is handled by trap

# Exit with test exit code
if [ $TEST_EXIT_CODE -eq 0 ]; then
  echo -e "${GREEN}✅ Authentication E2E tests passed!${NC}"
  exit 0
else
  echo -e "${RED}❌ Authentication E2E tests failed!${NC}"
  exit 1
fi
