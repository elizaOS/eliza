#!/bin/bash

# Define the path to the lerna.json file
LERNA_FILE="../../lerna.json"

# Check if lerna.json exists
if [ ! -f "${LERNA_FILE}" ]; then
  echo "Error: ${LERNA_FILE} does not exist."
  exit 1
fi

# Check if we have write permissions to the destination directory
if [ ! -w "src/lib" ]; then
  echo "Error: No write permission to src/lib directory."
  exit 1
fi

# Extract the version property from lerna.json using grep and awk
VERSION=$(grep -o '"version": *"[^"]*"' "$LERNA_FILE" | awk -F: '{ gsub(/[ ",]/, "", $2); print $2 }')

# Check if version was successfully extracted
if [ -z "$VERSION" ]; then
  echo "Error: Unable to extract version from $LERNA_FILE."
  exit 1
fi

# Create or overwrite info.json with the version property
echo "{\"version\": \"$VERSION\"}" > src/lib/info.json