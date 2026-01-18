# Rate Limiting System

## Quick Start

This directory contains the rate limiting and duplicate detection system for the Polyagent platform.

## Features

✅ **User-level rate limiting** with sliding window algorithm  
✅ **Duplicate content detection** to prevent spam  
✅ **Configurable limits** for different actions  
✅ **Easy integration** with middleware helpers  
✅ **Automatic cleanup** to prevent memory leaks  

## Usage

### Import

```typescript
import { 
  checkRateLimitAndDuplicates,
  RATE_LIMIT_CONFIGS,
  DUPLICATE_DETECTION_CONFIGS 
} from '@polyagent/api';
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

## Duplicate Detection Windows

- **Posts**: 5 minutes
- **Comments**: 2 minutes  
- **Messages**: 1 minute

## Files

- `user-rate-limiter.ts` - Core rate limiting logic
- `duplicate-detector.ts` - Duplicate content detection
- `middleware.ts` - Helper functions for routes
- `index.ts` - Exports
- `README.md` - This file

## Testing

```bash
bun test packages/testing/unit/rate-limiting.test.ts
```


