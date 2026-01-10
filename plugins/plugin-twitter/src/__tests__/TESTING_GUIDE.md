# Twitter Plugin Testing Guide

## Overview

This guide explains how to test the Twitter plugin after removing username/password authentication and Twitter Spaces functionality.

The plugin supports multiple auth modes:
- `TWITTER_AUTH_MODE=env` (legacy OAuth 1.0a keys/tokens)
- `TWITTER_AUTH_MODE=oauth` (OAuth 2.0 Authorization Code + PKCE, interactive “login + approve”, no client secret)
- `TWITTER_AUTH_MODE=broker` (stub only, not implemented yet)

## Prerequisites

### 1. Twitter Developer Account

You need a Twitter Developer account. Which credentials you need depends on auth mode:

- For `TWITTER_AUTH_MODE=env` (E2E tests use this):
  - API Key
  - API Secret Key
  - Access Token
  - Access Token Secret
- For `TWITTER_AUTH_MODE=oauth`:
  - OAuth 2.0 Client ID (`TWITTER_CLIENT_ID`)
  - Redirect URI (`TWITTER_REDIRECT_URI`)

To get these credentials:

1. Go to https://developer.twitter.com/
2. Create a developer account (if you don't have one)
3. Create a new app in the developer portal
4. Generate API keys and access tokens

### 2. Environment Setup

Create a `.env.test` file in the plugin root directory:

```bash
TWITTER_AUTH_MODE=env
TWITTER_API_KEY=your_api_key_here
TWITTER_API_SECRET_KEY=your_api_secret_key_here
TWITTER_ACCESS_TOKEN=your_access_token_here
TWITTER_ACCESS_TOKEN_SECRET=your_access_token_secret_here
```

## Running Tests

### Unit Tests

Unit tests mock external dependencies and test individual components:

```bash
# Run all unit tests
npm test

# Run specific test file
npm test MessageService.test.ts

# Run with coverage
npm test -- --coverage

# Run in watch mode
npm test -- --watch
```

### E2E Tests

End-to-end tests require real Twitter API credentials:

```bash
# Run E2E tests (requires .env.test file)
npm test -- --run e2e

# Skip E2E tests if no credentials
npm test -- --run --exclude="**/e2e/**"
```

## Test Coverage

### 1. Authentication Tests (`auth.test.ts`)

- ✅ Twitter API v2 initialization
- ✅ Credential validation
- ✅ Profile fetching
- ❌ Username/password login (removed)
- ❌ Guest authentication (removed)

### 2. Service Tests

#### MessageService Tests

- ✅ Fetching direct messages
- ✅ Sending direct messages
- ✅ Fetching mentions
- ✅ Message filtering
- ✅ Error handling

#### PostService Tests

- ✅ Creating posts/tweets
- ✅ Deleting posts
- ✅ Fetching posts
- ✅ Liking posts
- ✅ Reposting/retweeting
- ❌ Media upload (not implemented in v2 wrapper)
- ❌ Unlike/unrepost (not implemented)

### 3. Environment Tests

- ✅ Configuration validation
- ✅ Target user filtering
- ✅ Required credentials check

## Manual Testing

### 1. Basic Tweet Operations

```typescript
// Test creating a tweet
const post = await postService.createPost({
  text: "Hello from ElizaOS!",
  agentId: "agent-123",
  roomId: "room-123",
});

// Test fetching tweets
const posts = await postService.getPosts({
  agentId: "agent-123",
  limit: 20,
});

// Test liking a tweet
await postService.likePost("tweet-id", "agent-123");
```

### 2. Direct Messages

```typescript
// Test fetching mentions
const mentions = await messageService.getMentions("agent-123", {
  limit: 10,
});

// Test sending a DM
const message = await messageService.sendMessage({
  recipientId: "user-id",
  text: "Hello!",
  type: MessageType.DM,
  agentId: "agent-123",
  roomId: "room-123",
});
```

## Debugging Tips

### 1. Check Authentication

```typescript
const isLoggedIn = await client.isLoggedIn();
console.log("Authenticated:", isLoggedIn);

const profile = await client.me();
console.log("Profile:", profile);
```

### 2. Enable Debug Logging

```bash
DEBUG=elizaos:* npm test
```

### 3. Common Issues

**Issue: "Missing required Twitter API credentials"**

- Ensure all 4 credentials are set in environment
- Check for typos in environment variable names

**Issue: "401 Unauthorized"**

- Verify credentials are correct
- Check if tokens have proper permissions
- Ensure app has read/write access

**Issue: "Rate limit exceeded"**

- Twitter API v2 has rate limits
- Wait 15 minutes before retrying
- Use pagination for large requests

## API Limitations

With Twitter API v2 only:

### Available Features

- ✅ Create tweets
- ✅ Delete tweets
- ✅ Like tweets
- ✅ Retweet
- ✅ Get tweets
- ✅ Get mentions
- ✅ Search tweets

### Unavailable Features

- ❌ Twitter Spaces (removed)
- ❌ Media upload (requires additional implementation)
- ❌ Unlike/unretweet (requires additional implementation)
- ❌ Fetch retweeters list
- ❌ Trends API
- ❌ Direct message conversations (requires additional permissions)

## Performance Testing

```bash
# Run performance benchmarks
npm run benchmark

# Test rate limiting
npm run test:rate-limits
```

## CI/CD Integration

For GitHub Actions:

```yaml
- name: Run Twitter Plugin Tests
  env:
    TWITTER_API_KEY: ${{ secrets.TWITTER_API_KEY }}
    TWITTER_API_SECRET_KEY: ${{ secrets.TWITTER_API_SECRET_KEY }}
    TWITTER_ACCESS_TOKEN: ${{ secrets.TWITTER_ACCESS_TOKEN }}
    TWITTER_ACCESS_TOKEN_SECRET: ${{ secrets.TWITTER_ACCESS_TOKEN_SECRET }}
  run: npm test
```

## Future Improvements

1. **Media Upload**: Implement Twitter API v2 media upload endpoint
2. **Unlike/Unretweet**: Add support for undoing actions
3. **DM Conversations**: Implement full conversation support with proper permissions
4. **Streaming API**: Add real-time tweet streaming support
5. **Analytics**: Add tweet performance metrics tracking

## Resources

- [Twitter API v2 Documentation](https://developer.twitter.com/en/docs/twitter-api)
- [twitter-api-v2 Library](https://github.com/PLhery/node-twitter-api-v2)
- [ElizaOS Documentation](https://github.com/elizaos/eliza)
