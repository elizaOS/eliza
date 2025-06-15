#!/bin/bash

# Check TypeScript types for Cypress tests
echo "Checking TypeScript types for Cypress tests..."
cd cypress && npx tsc --noEmit --project tsconfig.json

if [ $? -eq 0 ]; then
  echo "✓ All TypeScript checks passed!"
else
  echo "✗ TypeScript errors found"
  exit 1
fi 