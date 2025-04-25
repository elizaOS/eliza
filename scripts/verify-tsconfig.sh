#!/bin/bash

# Script to verify that all tsconfig.json files are valid JSON

echo "🔍 Verifying tsconfig.json files..."

# Track if we found any issues
found_issues=0

# Check all tsconfig.json files
for tsconfig in $(find packages -name "tsconfig*.json"); do
  echo "Checking $tsconfig for JSON validity..."
  
  # Use Node.js to parse the JSON and check for validity
  if ! node -e "try { JSON.parse(require('fs').readFileSync('$tsconfig', 'utf8')); console.log('✅ Valid JSON'); } catch(e) { console.error('❌ Invalid JSON:', e.message); process.exit(1); }"; then
    echo "❌ Error: $tsconfig contains invalid JSON"
    found_issues=1
  fi
done

# Check for duplicate "types" entries in all tsconfig files
for tsconfig in $(find packages -name "tsconfig*.json"); do
  # Count occurrences of "types": pattern
  types_count=$(grep -c '"types"' "$tsconfig" || true)
  
  if [ "$types_count" -gt 1 ]; then
    echo "❌ Error: $tsconfig contains $types_count 'types' entries (should only have one)"
    cat "$tsconfig" | grep -n '"types"'
    found_issues=1
  fi
done

if [ $found_issues -eq 0 ]; then
  echo "✅ All tsconfig.json files are valid"
  exit 0
else
  echo "❌ Found issues with tsconfig.json files"
  exit 1
fi 