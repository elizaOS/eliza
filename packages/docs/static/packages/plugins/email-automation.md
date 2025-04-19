# @elizaos/plugin-email-automation

## Purpose

AI-powered email automation plugin for Eliza that intelligently detects email-worthy conversations and handles generation/delivery.

## Key Features

1. Intelligent Detection

   - Partnership opportunity detection
   - Technical discussion recognition
   - Business proposal identification
   - Follow-up requirement analysis

2. AI-Powered Generation
   - Structured email formatting
   - Context-aware content
   - Professional tone maintenance
   - Technical detail inclusion

## Configuration

```typescript
# Required
RESEND_API_KEY=           # Your Resend API key
DEFAULT_TO_EMAIL=         # Default recipient
DEFAULT_FROM_EMAIL=       # Default sender

# Optional Settings
EMAIL_AUTOMATION_ENABLED=true    # Enable AI detection
EMAIL_EVALUATION_PROMPT=        # Custom detection criteria for shouldEmail
```

## Integration

```typescript
import { emailAutomationPlugin } from '@elizaos/plugin-email-automation';

// Add to your Eliza configuration
{
    plugins: [emailAutomationPlugin],
    settings: {
        EMAIL_AUTOMATION_ENABLED: true,
        // ... other settings
    }
}
```

## Development

```bash
# Installation
bun install

# Testing
bun test
bun test:watch
bun test:coverage

# Building
bun build
```

## Links

- [Resend Documentation](https://resend.com/docs)
- [Email API Reference](https://resend.com/docs/api-reference/introduction)
- [Developer Portal](https://resend.com/overview)
