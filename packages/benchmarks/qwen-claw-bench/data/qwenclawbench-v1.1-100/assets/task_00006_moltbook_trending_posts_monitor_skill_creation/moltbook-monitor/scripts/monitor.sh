#!/usr/bin/env bash
# Moltbook Trending Posts Monitor
# Fetches trending posts, deduplicates against cache, and pushes notifications.
# Usage: ./monitor.sh [--dry-run] [--category CATEGORY] [--force]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_FILE="${BASE_DIR}/config.yaml"
CACHE_DIR="${BASE_DIR}/cache"
LOG_DIR="${BASE_DIR}/logs"
LOG_FILE="${LOG_DIR}/monitor.log"

# Defaults
DRY_RUN=false
FORCE=false
CATEGORY="all"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)   DRY_RUN=true; shift ;;
    --force)     FORCE=true; shift ;;
    --category)  CATEGORY="$2"; shift 2 ;;
    *)           echo "Unknown option: $1"; exit 1 ;;
  esac
done

log() {
  local level="$1"; shift
  echo "[${TIMESTAMP}] [${level}] $*" | tee -a "$LOG_FILE"
}

mkdir -p "$CACHE_DIR" "$LOG_DIR"

log "INFO" "Starting Moltbook monitor run (category=${CATEGORY}, dry_run=${DRY_RUN}, force=${FORCE})"

# Check active hours (Asia/Shanghai)
CURRENT_HOUR=$(TZ="Asia/Shanghai" date +"%H")
if [[ "$FORCE" == "false" ]] && (( CURRENT_HOUR >= 1 && CURRENT_HOUR < 7 )); then
  log "INFO" "Outside active hours (${CURRENT_HOUR}:xx CST). Skipping."
  exit 0
fi

# Load API key
if [[ -z "${MOLTBOOK_API_KEY:-}" ]]; then
  log "ERROR" "MOLTBOOK_API_KEY not set"
  exit 1
fi

API_BASE="https://api.moltbook.io/v2"
TRENDING_ENDPOINT="${API_BASE}/posts/trending"

# Fetch trending posts
log "INFO" "Fetching trending posts from Moltbook API..."
RESPONSE=$(curl -sS --max-time 30 \
  -H "Authorization: Bearer ${MOLTBOOK_API_KEY}" \
  -H "Accept: application/json" \
  "${TRENDING_ENDPOINT}?category=${CATEGORY}&time_window=24h&min_score=150&limit=25&locale=zh-CN" \
  2>&1) || {
  log "ERROR" "API request failed: ${RESPONSE}"
  exit 1
}

# Validate response
if ! echo "$RESPONSE" | python3 -c "import sys, json; json.load(sys.stdin)" 2>/dev/null; then
  log "ERROR" "Invalid JSON response from API"
  exit 1
fi

# Extract post count
POST_COUNT=$(echo "$RESPONSE" | python3 -c "import sys, json; d=json.load(sys.stdin); print(len(d.get('posts', [])))")
log "INFO" "Fetched ${POST_COUNT} trending posts"

# Dedup against cache
SEEN_FILE="${CACHE_DIR}/seen_posts.json"
if [[ ! -f "$SEEN_FILE" ]]; then
  echo '{}' > "$SEEN_FILE"
fi

NEW_POSTS=$(python3 "${SCRIPT_DIR}/dedup.py" \
  --input <(echo "$RESPONSE") \
  --seen "$SEEN_FILE" \
  --window-hours 12 \
  --strategy post_id)

NEW_COUNT=$(echo "$NEW_POSTS" | python3 -c "import sys, json; d=json.load(sys.stdin); print(len(d.get('posts', [])))")
log "INFO" "After dedup: ${NEW_COUNT} new posts"

if [[ "$NEW_COUNT" -eq 0 ]]; then
  log "INFO" "No new trending posts. Done."
  exit 0
fi

# Classify posts by score threshold
CLASSIFIED=$(echo "$NEW_POSTS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
viral = [p for p in data['posts'] if p.get('score', 0) >= 2000]
hot = [p for p in data['posts'] if 500 <= p.get('score', 0) < 2000]
normal = [p for p in data['posts'] if p.get('score', 0) < 500]
print(json.dumps({'viral': len(viral), 'hot': len(hot), 'normal': len(normal)}))
")
log "INFO" "Classification: ${CLASSIFIED}"

# Format and push notifications
if [[ "$DRY_RUN" == "true" ]]; then
  log "INFO" "[DRY-RUN] Would push ${NEW_COUNT} posts"
  echo "$NEW_POSTS" | python3 -m json.tool
  exit 0
fi

# Push to configured channels
python3 "${SCRIPT_DIR}/push_notification.py" \
  --config "$CONFIG_FILE" \
  --posts <(echo "$NEW_POSTS") \
  --max-posts 10

# Save run metadata
RUN_META="${CACHE_DIR}/last_run.json"
python3 -c "
import json, datetime
meta = {
    'timestamp': '${TIMESTAMP}',
    'posts_fetched': ${POST_COUNT},
    'posts_new': ${NEW_COUNT},
    'category': '${CATEGORY}',
    'status': 'success'
}
with open('${RUN_META}', 'w') as f:
    json.dump(meta, f, indent=2)
"

log "INFO" "Monitor run complete. Pushed ${NEW_COUNT} posts."
