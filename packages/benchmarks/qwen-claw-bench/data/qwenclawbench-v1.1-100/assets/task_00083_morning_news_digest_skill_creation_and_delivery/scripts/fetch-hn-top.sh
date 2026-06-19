#!/usr/bin/env bash
# Fetch top Hacker News stories via API
# Used by the morning digest workflow

set -euo pipefail

COUNT=${1:-10}
API="https://hacker-news.firebaseio.com/v0"

echo "Fetching top ${COUNT} HN stories..."

# Get top story IDs
TOP_IDS=$(curl -s "${API}/topstories.json" | python3 -c "
import sys, json
ids = json.load(sys.stdin)[:${COUNT}]
print(json.dumps(ids))
")

echo "$TOP_IDS" | python3 -c "
import sys, json, urllib.request

ids = json.load(sys.stdin)
stories = []
for sid in ids:
    url = f'https://hacker-news.firebaseio.com/v0/item/{sid}.json'
    with urllib.request.urlopen(url) as resp:
        item = json.loads(resp.read())
        stories.append({
            'title': item.get('title', ''),
            'url': item.get('url', ''),
            'score': item.get('score', 0),
            'by': item.get('by', ''),
            'time': item.get('time', 0)
        })

for i, s in enumerate(stories, 1):
    print(f\"{i}. [{s['score']}pts] {s['title']}\")
    print(f\"   {s['url']}\")
    print()
"
