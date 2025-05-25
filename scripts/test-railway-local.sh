#!/bin/bash

# Script to test Railway deployment locally

echo "Testing Railway deployment locally..."

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "Docker is not installed. Please install Docker first."
    exit 1
fi

# Build the Docker image
echo "Building Docker image..."
docker build -f Dockerfile.railway -t eliza-railway-test .

if [ $? -ne 0 ]; then
    echo "Docker build failed!"
    exit 1
fi

echo "Docker build successful!"

# Run the container
echo "Running container..."
echo "Note: Make sure to set the following environment variables:"
echo "  - OPENAI_API_KEY"
echo "  - ANTHROPIC_API_KEY"
echo "  - DATABASE_URL or POSTGRES_URL"
echo ""
echo "Example:"
echo "docker run -p 3000:3000 \\"
echo "  -e OPENAI_API_KEY=your_key \\"
echo "  -e ANTHROPIC_API_KEY=your_key \\"
echo "  -e DATABASE_URL=postgresql://user:pass@host:5432/db \\"
echo "  -e LOG_LEVEL=debug \\"
echo "  eliza-railway-test"

# Optionally run with environment variables from .env file
if [ -f .env ]; then
    echo ""
    echo "Found .env file. Running with environment variables..."
    docker run -p 3000:3000 --env-file .env eliza-railway-test
else
    echo ""
    echo "No .env file found. Please create one or run the docker command manually with environment variables."
fi