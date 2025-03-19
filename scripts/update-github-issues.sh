#!/bin/bash

# Update GitHub Issues and Restart Eliza with RAG
# This script fetches the latest GitHub issues and restarts Eliza

# Configuration
ELIZA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="$ELIZA_DIR/scripts/fetch-github-issues.js"
CHARACTER_PATH="$ELIZA_DIR/characters/rag-eliza.json"

# Log file
LOG_FILE="$ELIZA_DIR/github-issues-update.log"

# Function to log messages
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# Navigate to Eliza directory
cd "$ELIZA_DIR" || {
  log "Error: Could not navigate to Eliza directory at $ELIZA_DIR"
  exit 1
}

# Fetch GitHub issues
log "Fetching GitHub issues..."
node "$SCRIPT_PATH" >> "$LOG_FILE" 2>&1
if [ $? -ne 0 ]; then
  log "Error: Failed to fetch GitHub issues. Check the log file for details."
  exit 1
fi
log "GitHub issues fetched successfully."

# Optional: Restart Eliza
# Uncomment these lines if you want the script to automatically restart Eliza
# log "Restarting Eliza with RAG-enabled character..."
# pnpm start --characters="$CHARACTER_PATH" >> "$LOG_FILE" 2>&1 &
# log "Eliza restarted with PID: $!"

log "Done. Eliza will use the updated GitHub issues on next startup."

# Instructions for manual usage
cat << EOF

===============================================
GitHub issues have been updated successfully.
To start Eliza with these issues, run:

  pnpm start --characters="$CHARACTER_PATH"

You can add this script to your crontab to run daily:

  0 0 * * * $(realpath "$0") > /dev/null 2>&1

===============================================
EOF
