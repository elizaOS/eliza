#!/bin/bash
# NAS Status Checker
# Polls Synology DSM API and updates data/nas-status.json

NAS_HOST="192.168.1.50"
NAS_PORT="5001"
NAS_USER="${NAS_USER:-admin}"
NAS_PASS="${NAS_PASS:-}"
OUTPUT="./data/nas-status.json"

if [ -z "$NAS_PASS" ]; then
  echo "Error: NAS_PASS environment variable not set"
  exit 1
fi

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Checking NAS status at ${NAS_HOST}..."

# Authenticate
AUTH_RESPONSE=$(curl -sk "https://${NAS_HOST}:${NAS_PORT}/webapi/auth.cgi?api=SYNO.API.Auth&version=3&method=login&account=${NAS_USER}&passwd=${NAS_PASS}&format=sid")
SID=$(echo "$AUTH_RESPONSE" | jq -r '.data.sid // empty')

if [ -z "$SID" ]; then
  echo "Error: Failed to authenticate with NAS"
  exit 1
fi

# Get storage info
STORAGE=$(curl -sk "https://${NAS_HOST}:${NAS_PORT}/webapi/entry.cgi?api=SYNO.Storage.CGI.Storage&version=1&method=load_info&_sid=${SID}")

# Get SMART info
SMART=$(curl -sk "https://${NAS_HOST}:${NAS_PORT}/webapi/entry.cgi?api=SYNO.Storage.CGI.Smart&version=1&method=get&_sid=${SID}")

# Logout
curl -sk "https://${NAS_HOST}:${NAS_PORT}/webapi/auth.cgi?api=SYNO.API.Auth&version=3&method=logout&_sid=${SID}" > /dev/null

# Parse and save (simplified — in production, use proper JSON parsing)
echo "$STORAGE" | jq '.' > "$OUTPUT"
echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Status saved to ${OUTPUT}"
