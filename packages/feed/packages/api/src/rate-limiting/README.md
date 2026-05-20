# Rate Limiting System

## Quick Start

This directory contains the rate limiting and duplicate detection system for the Babylon platform.

## Features

✅ **User-level rate limiting** with sliding window algorithm  
✅ **Public API tiered rate limiting** (per-IP for anonymous, per-user for authenticated)  
✅ **Duplicate content detection** to prevent spam  
✅ **Configurable limits** for different actions  
✅ **Easy integration** with middleware helpers  
✅ **Automatic cleanup** to prevent memory leaks  

---

## Public API Tiered Rate Limiting

### Why we have it

- **Abuse**: Public GET endpoints (feeds, markets, profiles) can be hammered by bots or scrapers without an account. Tiered limits cap anonymous traffic per IP while giving identified users (and API keys) higher quotas.
- **Cost & stability**: Unbounded public reads increase DB and CDN cost and can degrade service for everyone. Rate limits keep usage predictable and allow caching (see `Cache-Control` below).
- **Fairness**: Authenticated users and API keys get higher limits (60/min read, 20/min firehose) because they are accountable; anonymous IPs get lower limits (20/min read, 5/min firehose) with a strict fallback when IP is unknown (10/min read, 2/min firehose).

### How it works

- **Key choice**: If the request has a valid auth token or API key → key = `userId` and we use the “authed” config. Otherwise we key by client IP (from `X-Forwarded-For` / `X-Real-IP` / etc.). If IP cannot be determined we use a shared `"anonymous"` bucket with the strictest limits (so we still limit even behind opaque proxies).
- **Two kinds of limits**: `read` for normal GET endpoints (posts, markets, profiles, etc.); `firehose` for SSE connection/token endpoints (long-lived, so we allow fewer connections per minute).
- **Null-user safety**: Endpoints that use `publicRateLimit()` may receive unauthenticated requests. Handlers must never assume `user` is non-null (guard with `if (user)`) and must not trust query params like `userId` or `following` for authorization—only the authenticated identity from the token/API key may scope user-specific data.

### Limits (per minute)

| Caller type              | Read endpoints | Firehose (SSE tokens/connections) |
|--------------------------|----------------|-----------------------------------|
| Public (no key, by IP)   | 20             | 5                                 |
| Authenticated / API key | 60             | 20                                |
| Anonymous (IP unknown)  | 10 (shared)    | 2 (shared)                        |

### Usage in a GET handler

```typescript
import { addPublicReadHeaders, publicRateLimit, successResponse } from '@babylon/api';

export async function GET(request: NextRequest) {
  const { error, user, rateLimitInfo } = await publicRateLimit(request);
  if (error) return error;

  // Use `user` instead of calling optionalAuth() again. user may be null.
  const data = await fetchPublicData(user?.userId);

  const res = successResponse(data);
  if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
  return res;
}
```

- **Why return `user`**: So the handler can avoid a second auth lookup and safely use the same identity for RLS or filtering when present.
- **Why `addPublicReadHeaders`**: Clients get `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` and `Cache-Control: public, s-maxage=5, stale-while-revalidate=10` so they can back off before hitting 429 and CDNs can cache responses to reduce load.

### Public firehose token

- **GET /api/realtime/public-token** issues a short-lived token scoped only to public SSE channels (`feed`, `markets`, `breaking-news`, `upcoming-events`). No login required. **Why**: Allows read-only clients (e.g. dashboards, embeds) to subscribe to the public firehose without signing in, while keeping private channels (DMs, notifications) behind the authenticated `POST /api/realtime/token` flow.
- This GET is rate limited with the **firehose** tier (5/min per IP for unauthenticated) so that token issuance itself cannot be abused.

---

## Usage (authenticated / write-side)

### Import

```typescript
import { 
  checkRateLimitAndDuplicates,
  RATE_LIMIT_CONFIGS,
  DUPLICATE_DETECTION_CONFIGS 
} from '@babylon/api';
```

### Apply Rate Limiting Only

```typescript
export async function POST(request: NextRequest) {
  const user = await authenticate(request);
  
  const rateLimitError = checkRateLimitAndDuplicates(
    user.userId,
    null,  // No content = no duplicate detection
    RATE_LIMIT_CONFIGS.LIKE_POST
  );
  
  if (rateLimitError) {
    return rateLimitError;  // Returns 429 if rate limit exceeded
  }
  
  // Proceed with request...
}
```

### Apply Rate Limiting + Duplicate Detection

```typescript
export async function POST(request: NextRequest) {
  const user = await authenticate(request);
  const { content } = await request.json();
  
  const errorResponse = checkRateLimitAndDuplicates(
    user.userId,
    content,  // Content provided = duplicate detection enabled
    RATE_LIMIT_CONFIGS.CREATE_POST,
    DUPLICATE_DETECTION_CONFIGS.POST
  );
  
  if (errorResponse) {
    return errorResponse;  // Returns 429 or 409
  }
  
  // Proceed with request...
}
```

## Rate Limits

### Authenticated / write-side (per user)

| Action | Limit/Minute |
|--------|-------------|
| Create Post | 3 |
| Create Comment | 10 |
| Like (Post/Comment) | 20 |
| Share Post | 5 |
| Follow/Unfollow | 10 |
| Send Message | 20 |
| Upload Image | 5 |
| Generate Agent Profile | 5 |
| Generate Agent Field | 10 |

### Public read / firehose (see table above)

## Duplicate Detection Windows

- **Posts**: 5 minutes
- **Comments**: 2 minutes  
- **Messages**: 1 minute

## Files

- `user-rate-limiter.ts` - Core rate limiting logic and configs (including public tiers)
- `middleware.ts` - `publicRateLimit()`, `addPublicReadHeaders()`, and other route helpers
- `duplicate-detector.ts` - Duplicate content detection
- `index.ts` - Exports
- `README.md` - This file

## Testing

```bash
bun test packages/testing/unit/rate-limiting.test.ts
```


