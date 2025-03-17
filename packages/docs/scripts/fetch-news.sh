#!/bin/bash
# Fetch news files for last 10 days into docs/news/

SOURCE_URL="https://m3-org.github.io/ai-news/elizaos/md"
OUTPUT_DIR="docs/news"

for i in {0..9}; do
    DATE=$(date -d "-$i days" '+%Y-%m-%d')
    wget -nc "$SOURCE_URL/$DATE.md" -P "$OUTPUT_DIR"
done
