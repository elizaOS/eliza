#!/bin/bash

# Test runner script for ElizaOS client
# This script starts the backend server and runs frontend tests

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
SERVER_PORT=${SERVER_PORT:-3000}
CLIENT_PORT=${CLIENT_PORT:-5173}
SERVER_DIR="../../packages/server"
CLIENT_DIR="."
WAIT_TIME=30
TEST_TYPE=${1:-all} # all, unit, component, e2e

# Function to print colored output
print_status() {
    echo -e "${GREEN}[TEST RUNNER]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

# Function to cleanup processes
cleanup() {
    print_status "Cleaning up..."
    
    # Kill server if running
    if [ ! -z "$SERVER_PID" ]; then
        kill $SERVER_PID 2>/dev/null || true
    fi
    
    # Kill client if running
    if [ ! -z "$CLIENT_PID" ]; then
        kill $CLIENT_PID 2>/dev/null || true
    fi
    
    # Kill any remaining processes on ports
    lsof -ti:$SERVER_PORT | xargs kill -9 2>/dev/null || true
    lsof -ti:$CLIENT_PORT | xargs kill -9 2>/dev/null || true
    
    exit $1
}

# Set up trap to cleanup on exit
trap 'cleanup $?' EXIT INT TERM

# Check if required commands exist
command -v bun >/dev/null 2>&1 || { print_error "bun is required but not installed."; exit 1; }
command -v cypress >/dev/null 2>&1 || { print_warning "cypress command not found, will use npx cypress"; }

# Check if server directory exists
if [ ! -d "$SERVER_DIR" ]; then
    print_error "Server directory not found at $SERVER_DIR"
    exit 1
fi

# Start the backend server using CLI
print_status "Starting backend server on port $SERVER_PORT..."
cd ../..
bun run start > /tmp/elizaos-server.log 2>&1 &
SERVER_PID=$!
cd - > /dev/null

# Wait for server to be ready
print_status "Waiting for server to be ready..."
for i in $(seq 1 $WAIT_TIME); do
    if curl -s http://localhost:$SERVER_PORT/health > /dev/null 2>&1; then
        print_status "Server is ready!"
        break
    fi
    if [ $i -eq $WAIT_TIME ]; then
        print_error "Server failed to start within $WAIT_TIME seconds"
        cat /tmp/elizaos-server.log
        exit 1
    fi
    sleep 1
done

# Start the client dev server
print_status "Starting client dev server on port $CLIENT_PORT..."
cd $CLIENT_DIR
bun run dev:client > /tmp/elizaos-client.log 2>&1 &
CLIENT_PID=$!

# Wait for client to be ready
print_status "Waiting for client to be ready..."
for i in $(seq 1 $WAIT_TIME); do
    if curl -s http://localhost:$CLIENT_PORT > /dev/null 2>&1; then
        print_status "Client is ready!"
        break
    fi
    if [ $i -eq $WAIT_TIME ]; then
        print_error "Client failed to start within $WAIT_TIME seconds"
        cat /tmp/elizaos-client.log
        exit 1
    fi
    sleep 1
done

# Run tests based on type
case $TEST_TYPE in
    unit)
        print_status "Running unit tests..."
        bun test
        ;;
    component)
        print_status "Running component tests..."
        if command -v cypress >/dev/null 2>&1; then
            cypress run --component
        else
            npx cypress run --component
        fi
        ;;
    e2e)
        print_status "Running E2E tests..."
        if command -v cypress >/dev/null 2>&1; then
            cypress run --e2e
        else
            npx cypress run --e2e
        fi
        ;;
    all)
        print_status "Running all tests..."
        
        # Run unit tests
        print_status "Running unit tests..."
        bun test
        
        # Run component tests
        print_status "Running component tests..."
        if command -v cypress >/dev/null 2>&1; then
            cypress run --component
        else
            npx cypress run --component
        fi
        
        # Run E2E tests
        print_status "Running E2E tests..."
        if command -v cypress >/dev/null 2>&1; then
            cypress run --e2e
        else
            npx cypress run --e2e
        fi
        ;;
    *)
        print_error "Unknown test type: $TEST_TYPE"
        echo "Usage: $0 [all|unit|component|e2e]"
        exit 1
        ;;
esac

 