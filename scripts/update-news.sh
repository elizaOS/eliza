#!/bin/bash

# Configuration
SOURCE_URL="https://m3-org.github.io/ai-news/elizaos/md"
OUTPUT_DIR="packages/docs/news"
MAX_DAYS_TO_CHECK=10  # Check last 10 days to catch any missed updates

# Create news directory if it doesn't exist
mkdir -p "$OUTPUT_DIR"

# Get current date
current_date=$(date +%Y-%m-%d)

echo "Fetching news files for the last $MAX_DAYS_TO_CHECK days..."

# Download news files for the last few days to catch any missed updates
for i in $(seq 0 $((MAX_DAYS_TO_CHECK-1))); do
    target_date=$(date -d "${current_date} - ${i} days" +%Y-%m-%d)
    echo "Checking ${target_date}..."
    
    # Only download if file doesn't exist or is empty
    if [ ! -s "${OUTPUT_DIR}/${target_date}.md" ]; then
        wget -nc "${SOURCE_URL}/${target_date}.md" -P "$OUTPUT_DIR" 2>/dev/null || \
            echo "No news file for ${target_date}"
    else
        echo "File for ${target_date} already exists and is not empty"
    fi
done

echo "Updating repomix config..."

# Update repomix config with recent news files
news_files=$(find "$OUTPUT_DIR" -name "*.md" -type f -mtime -${MAX_DAYS_TO_CHECK} | sort -r | jq -R . | jq -s .)

# Use jq to update the config file
jq --argjson news "$news_files" '
    .include = (
        .include + 
        ($news | map(. | tostring)) | 
        unique
    )
' scripts/repomix.config.json > scripts/repomix.config.json.tmp && \
mv scripts/repomix.config.json.tmp scripts/repomix.config.json

echo "Updated repomix config with recent news files" 