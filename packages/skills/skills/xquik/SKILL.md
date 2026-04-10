---
name: xquik
description: "Search X/Twitter, look up tweets, user profiles, and trending topics via Xquik REST API. Works on servers and in Docker — no browser cookies or CLI install needed, just an API key and curl. Use when the user asks to search Twitter, find what people are saying about a topic, look up a user's profile or recent tweets, check trending topics, read a specific tweet, research community sentiment, or monitor social media reactions. Especially useful in headless/server environments where the bird skill cannot authenticate."
homepage: https://xquik.com
metadata:
  {
    "otto":
      {
        "emoji": "𝕏",
        "requires": { "bins": ["curl", "jq"], "env": ["XQUIK_API_KEY"] },
      },
  }
---

# Xquik — X/Twitter Search & Research

Search tweets, look up users, check trends — works on servers, Docker, CI, and any headless environment. API key auth only, no browser cookies needed.

## When to use

Use this skill when:

- User asks "what are people saying about X" / "what's Twitter saying about Y"
- User wants to research community sentiment or reactions on a topic
- User wants to look up a specific tweet, user profile, or trending topics
- **The bird skill can't authenticate** (no browser on this machine for cookie extraction)
- Agent is running on a server, in Docker, or in any headless environment

## Setup

Set `XQUIK_API_KEY` in your environment. Get a key at [xquik.com](https://xquik.com).

## Search Tweets

```bash
curl -s "https://xquik.com/api/v1/x/tweets/search?q=QUERY&limit=10&queryType=Top" \
  -H "X-API-Key: $XQUIK_API_KEY"
```

`queryType`: `Top` (engagement-sorted, best for research) or `Latest` (chronological).

Supports X search operators: `from:user`, `to:user`, `#hashtag`, `"exact phrase"`, `since:2025-01-01`, `until:2025-12-31`, `-is:retweet`, `-is:reply`, `has:media`, `has:links`.

### Extract structured data with jq

```bash
# Get top tweets with engagement metrics
curl -s "https://xquik.com/api/v1/x/tweets/search?q=QUERY&limit=10&queryType=Top" \
  -H "X-API-Key: $XQUIK_API_KEY" | jq '[.tweets[] | {
    user: .author.username,
    text: .text,
    likes: .likeCount,
    retweets: .retweetCount,
    views: .viewCount,
    url: "https://x.com/\(.author.username)/status/\(.id)"
  }]'
```

### Common search patterns

```bash
# What are people saying about a topic
curl -s "https://xquik.com/api/v1/x/tweets/search?q=AI+agents+-is:retweet&limit=15&queryType=Top" \
  -H "X-API-Key: $XQUIK_API_KEY"

# Recent tweets from a specific user
curl -s "https://xquik.com/api/v1/x/tweets/search?q=from:USERNAME+-is:retweet&limit=10&queryType=Latest" \
  -H "X-API-Key: $XQUIK_API_KEY"

# Reactions to a product launch
curl -s "https://xquik.com/api/v1/x/tweets/search?q=%22product+name%22+-is:retweet&limit=20&queryType=Top" \
  -H "X-API-Key: $XQUIK_API_KEY"

# Developer discussion with links
curl -s "https://xquik.com/api/v1/x/tweets/search?q=TOPIC+has:links+-is:retweet&limit=10&queryType=Top" \
  -H "X-API-Key: $XQUIK_API_KEY"
```

## Read a Single Tweet

```bash
curl -s "https://xquik.com/api/v1/x/tweets/TWEET_ID" \
  -H "X-API-Key: $XQUIK_API_KEY"
```

## User Profile

```bash
curl -s "https://xquik.com/api/v1/x/users/USERNAME" \
  -H "X-API-Key: $XQUIK_API_KEY" | jq '{name: .name, username: .username, bio: .description, followers: .followers, following: .following, verified: .verified}'
```

## Search Users

```bash
curl -s "https://xquik.com/api/v1/x/users/search?q=QUERY" \
  -H "X-API-Key: $XQUIK_API_KEY" | jq '[.users[] | {username: .username, name: .name, followers: .followers, bio: .description}]'
```

## Trending Topics

```bash
curl -s "https://xquik.com/api/v1/trends?woeid=WOEID&count=20" \
  -H "X-API-Key: $XQUIK_API_KEY" | jq '[.trends[] | {rank, name}]'
```

WOEID codes: `1` Global, `23424977` US, `23424975` UK, `23424969` Turkey, `23424856` Japan, `23424848` India.

## Research Workflow

For deep research on a topic, follow this sequence:

1. **Check trends** to see if the topic is trending:
   ```bash
   curl -s "https://xquik.com/api/v1/trends?woeid=1&count=30" -H "X-API-Key: $XQUIK_API_KEY" | jq '[.trends[] | .name]'
   ```

2. **Search for top tweets** to find high-signal discussion:
   ```bash
   curl -s "https://xquik.com/api/v1/x/tweets/search?q=TOPIC+-is:retweet&limit=20&queryType=Top" -H "X-API-Key: $XQUIK_API_KEY"
   ```

3. **Find expert voices** by checking who the most-liked authors are, then look up their profiles:
   ```bash
   curl -s "https://xquik.com/api/v1/x/users/USERNAME" -H "X-API-Key: $XQUIK_API_KEY"
   ```

4. **Get their recent takes** on the topic:
   ```bash
   curl -s "https://xquik.com/api/v1/x/tweets/search?q=from:USERNAME+TOPIC&limit=10&queryType=Latest" -H "X-API-Key: $XQUIK_API_KEY"
   ```

5. **Summarize findings** by grouping tweets by theme, noting engagement levels as a signal of community agreement.

## Pagination

Pass `cursor` from the previous response to get the next page:

```bash
curl -s "https://xquik.com/api/v1/x/tweets/search?q=QUERY&limit=20&queryType=Top&cursor=NEXT_CURSOR" \
  -H "X-API-Key: $XQUIK_API_KEY"
```

Check `has_next_page` (boolean) and `next_cursor` (string) in the response.

## Response Shape

Tweet objects include: `id`, `text`, `createdAt`, `likeCount`, `retweetCount`, `replyCount`, `quoteCount`, `viewCount`, `bookmarkCount`, `author.username`, `author.name`, `author.verified`.

User objects include: `id`, `username`, `name`, `description`, `followers`, `following`, `verified`, `statusesCount`, `createdAt`.

## When to use xquik vs bird

| | xquik | bird |
|---|---|---|
| **Auth** | API key (env var) | Browser cookies (needs logged-in browser) |
| **Install** | None (curl + jq) | `npm i -g @steipete/bird` |
| **Server/Docker** | Works everywhere | Fails (no browser for cookies) |
| **Search** | Stable REST API | GraphQL (breaks on X frontend changes) |
| **Posting** | Not supported | Supported |
| **Data** | likes, RTs, replies, quotes, views, bookmarks | likes, RTs, replies |

**Use xquik** for search, research, reading, and server-side operation.
**Use bird** when you need to post tweets or access personal timelines on a local machine with a browser.
