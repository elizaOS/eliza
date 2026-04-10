---
name: xquik
description: "Search X/Twitter, look up tweets, user profiles, and trending topics via the Xquik REST API. No CLI install needed — uses curl with an API key. Use when the user wants to search Twitter, find tweets about a topic, look up a user's profile, check trending topics, read a specific tweet, or get real-time social media perspectives. Alternative to bird that doesn't require cookie auth or browser login."
homepage: https://xquik.com
metadata:
  {
    "otto":
      {
        "emoji": "𝕏",
        "requires": { "bins": ["curl"] },
      },
  }
---

# Xquik — X/Twitter API

Search tweets, look up users, read threads, and check trends. API key auth — no cookies, no browser login, no CLI install.

Set `XQUIK_API_KEY` environment variable. Get a key at [xquik.com](https://xquik.com).

## Search Tweets

```bash
curl -s "https://xquik.com/api/v1/x/tweets/search?q=QUERY&limit=10&queryType=Top" \
  -H "X-API-Key: $XQUIK_API_KEY" | jq '.tweets[] | {user: .author.username, text: .text, likes: .likeCount, views: .viewCount}'
```

Supports X search operators: `from:user`, `#hashtag`, `"exact phrase"`, `since:2025-01-01`, `until:2025-12-31`, `min_faves:100`, `-is:retweet`, `-is:reply`.

Examples:

```bash
# Search by topic
curl -s "https://xquik.com/api/v1/x/tweets/search?q=AI+agents&limit=10&queryType=Top" \
  -H "X-API-Key: $XQUIK_API_KEY"

# Search by user
curl -s "https://xquik.com/api/v1/x/tweets/search?q=from:elonmusk&limit=5&queryType=Latest" \
  -H "X-API-Key: $XQUIK_API_KEY"

# Search with filters
curl -s "https://xquik.com/api/v1/x/tweets/search?q=%23buildinpublic+-is:retweet&limit=10&queryType=Top" \
  -H "X-API-Key: $XQUIK_API_KEY"
```

`queryType`: `Top` (engagement-sorted) or `Latest` (chronological).

## Read a Single Tweet

```bash
curl -s "https://xquik.com/api/v1/x/tweets/TWEET_ID" \
  -H "X-API-Key: $XQUIK_API_KEY" | jq '{text: .text, user: .author.username, likes: .likeCount, retweets: .retweetCount, views: .viewCount}'
```

## User Profile

```bash
curl -s "https://xquik.com/api/v1/x/users/USERNAME" \
  -H "X-API-Key: $XQUIK_API_KEY" | jq '{name: .name, username: .username, followers: .followers, following: .following, bio: .description}'
```

## Search Users

```bash
curl -s "https://xquik.com/api/v1/x/users/search?q=QUERY" \
  -H "X-API-Key: $XQUIK_API_KEY" | jq '.users[] | {username: .username, name: .name, followers: .followers}'
```

## Trending Topics

```bash
# Global trends
curl -s "https://xquik.com/api/v1/trends?woeid=1&count=20" \
  -H "X-API-Key: $XQUIK_API_KEY" | jq '.trends[] | {rank, name}'

# US trends
curl -s "https://xquik.com/api/v1/trends?woeid=23424977&count=20" \
  -H "X-API-Key: $XQUIK_API_KEY"
```

WOEID codes: `1` (Global), `23424977` (US), `23424975` (UK), `23424969` (Turkey), `23424856` (Japan).

## Response Format

**Tweet search** returns:

```json
{
  "tweets": [
    {
      "id": "1234567890",
      "text": "Tweet content",
      "createdAt": "2025-01-15T12:00:00Z",
      "likeCount": 42,
      "retweetCount": 5,
      "replyCount": 3,
      "quoteCount": 1,
      "viewCount": 1500,
      "bookmarkCount": 2,
      "author": {
        "username": "handle",
        "name": "Display Name",
        "verified": true
      }
    }
  ],
  "has_next_page": true,
  "next_cursor": "..."
}
```

## Tips

- Use `jq` to extract fields — the API returns detailed JSON
- URL-encode special characters in queries: spaces as `+`, `#` as `%23`
- Pagination: pass `cursor=NEXT_CURSOR` from the previous response
- Cost: $0.00015 per tweet read (33x cheaper than X API v2)

## vs bird

| | xquik | bird |
|---|---|---|
| Auth | API key (`XQUIK_API_KEY`) | Browser cookies (`auth_token` + `ct0`) |
| Install | None (uses curl) | `npm i -g @steipete/bird` |
| Search | Stable API | GraphQL (may break on X updates) |
| Posting | Not supported | Supported |
| Engagement data | likes, RTs, replies, quotes, views, bookmarks | likes, RTs, replies |

Use **xquik** for search and reading. Use **bird** if you need to post tweets or access timelines.
