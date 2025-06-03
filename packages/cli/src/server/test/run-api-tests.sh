#!/bin/bash

# Run API Route Tests
echo "🚀 Running API Route Tests..."
cd "$(dirname "$0")/../../.."
npx tsx src/server/test/api-routes.test.ts 