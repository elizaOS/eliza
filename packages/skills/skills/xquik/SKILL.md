---
name: xquik
description: Search public X posts, read threads, inspect profiles, and list trends through the Xquik API. Use for X or Twitter research when an Eliza agent needs structured public data without connecting an X account. Keep writes, DMs, and account actions in plugin-x.
homepage: https://docs.xquik.com
required-bins:
  - curl
  - jq
required-env:
  - XQUIK_API_KEY
metadata:
  otto:
    emoji: "𝕏"
    requires:
      bins:
        - curl
        - jq
      env:
        - XQUIK_API_KEY
---

# Xquik public X reads

Use Xquik for public X research. The bundled script builds safe requests.

Use `plugin-x` for posts, replies, DMs, likes, and connected accounts.

## Setup

Create an API key in the Xquik dashboard. Set it as `XQUIK_API_KEY`.

Never print, persist, or include the key in a prompt or URL.

## Search public posts

Pass the query as one quoted argument. The script URL-encodes it.

```bash
QUERY='elizaOS agents -is:retweet'
{baseDir}/scripts/xquik-read.sh search "$QUERY" Top 20 |
  jq '[.tweets[] | {
    id,
    text,
    url,
    createdAt,
    author: .author.username,
    likes: .likeCount,
    reposts: .retweetCount,
    replies: .replyCount,
    views: .viewCount
  }]'
```

Use `Latest` for chronological results. Use `Top` for engagement ranking.

Supported search syntax includes `from:`, `to:`, hashtags, quoted phrases,
`OR`, and exclusions. Preserve the user's query. Do not add filters.

## Read one post

Extract the 15 to 20 digit post ID from its URL.

```bash
{baseDir}/scripts/xquik-read.sh tweet 1893456789012345678 |
  jq '{tweet: .tweet, author: .author}'
```

## Read a thread

```bash
{baseDir}/scripts/xquik-read.sh thread 1893456789012345678 |
  jq '[.tweets[] | {id, text, author: .author.username, createdAt}]'
```

## Inspect a public profile

Pass a username without `@`, or pass a numeric user ID.

```bash
{baseDir}/scripts/xquik-read.sh user elizaOS |
  jq '{id, username, name, description, followers, following, verified}'
```

## List trends

Pass a WOEID and a result count from 1 to 50.

```bash
{baseDir}/scripts/xquik-read.sh trends 1 20 |
  jq '[.trends[] | {rank, name, tweetVolume, url}]'
```

Common WOEIDs include worldwide `1`, US `23424977`, UK `23424975`, and
Turkey `23424969`.

## Pagination

Search and thread responses can return `has_next_page` and `next_cursor`.

Pass an opaque search cursor as argument 5:

```bash
{baseDir}/scripts/xquik-read.sh search "$QUERY" Latest 20 "$NEXT_CURSOR"
```

Pass an opaque thread cursor as argument 3:

```bash
{baseDir}/scripts/xquik-read.sh thread 1893456789012345678 "$NEXT_CURSOR"
```

Never decode cursors. An empty page can still have another page.

## Failure handling

The script returns nonzero for API errors and preserves the response body.

- `400`: fix the request. Do not retry unchanged input.
- `401`: set a valid `XQUIK_API_KEY`.
- `402`: stop. Credits or payment are required.
- `404`: report that the public resource was not found.
- `424`, `429`, or `5xx`: inspect the error and `Retry-After` first.

Do not turn an error into an empty result. Avoid automatic pagination.

Xquik is an independent third-party service. Not affiliated with X Corp.
"Twitter" and "X" are trademarks of X Corp.

Contract: https://xquik.com/openapi.json
