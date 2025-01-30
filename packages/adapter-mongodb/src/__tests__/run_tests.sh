#!/bin/bash

# Function to cleanup resources
cleanup() {
    echo "Cleaning up resources..."
    docker-compose -f docker-compose.test.yml down
    exit 0
}

# Trap SIGINT and SIGTERM signals and cleanup
trap cleanup SIGINT SIGTERM

# Start MongoDB container
echo "Starting MongoDB container..."
docker-compose -f docker-compose.test.yml up -d

# Wait for MongoDB to be ready
echo "Waiting for MongoDB to be ready..."
until docker-compose -f docker-compose.test.yml exec -T mongodb-test mongosh --eval "db.adminCommand('ping')" > /dev/null 2>&1; do
    echo "MongoDB is not ready yet..."
    sleep 1
done

echo "MongoDB is ready!"

# Run tests
echo "Running tests..."
jest --runInBand --forceExit

# Cleanup after tests
cleanup