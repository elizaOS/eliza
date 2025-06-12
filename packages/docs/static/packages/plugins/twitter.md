# @elizaos/plugin-twitter

## Purpose

A plugin for Twitter/X integration, providing automated tweet posting capabilities with character-aware content generation.

## Key Features

- Compose context-aware tweets
- Post tweets to Twitter/X platform
- Handle authentication and session management
- Support premium Twitter features
- Manage tweet length restrictions

## Installation

```bash
npm install @elizaos/plugin-twitter
```

## Integration

Import and register the plugin in Eliza configuration:

```typescript
import { twitterPlugin } from '@elizaos/plugin-twitter';

export default {
  plugins: [twitterPlugin],
  // ... other configuration
};
```

## Example Usage

```typescript
import { postAction } from '@elizaos/plugin-twitter';

// Tweet will be composed based on context and character limits
const result = await postAction.handler(runtime, message, state);

// Post with automatic content generation
await postAction.handler(runtime, message, state);

// Dry run mode (for testing)
process.env.TWITTER_DRY_RUN = 'true';
await postAction.handler(runtime, message, state);
```
