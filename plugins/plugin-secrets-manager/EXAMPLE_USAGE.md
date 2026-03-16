# Example Usage: Enhanced Secrets Manager

This document provides practical examples of how to use the enhanced secrets manager in your elizaOS plugins.

## Basic Setup

### 1. Import the Types and Service

```typescript
import { type IAgentRuntime, type Memory } from '@elizaos/core';
import {
  type EnhancedSecretManager,
  type SecretContext,
  type SecretConfig,
} from '@elizaos/plugin-env';
```

### 2. Access the Service

```typescript
// In your action or provider
const secretsManager = runtime.getService('SECRETS') as EnhancedSecretManager;
if (!secretsManager) {
  throw new Error('Secrets manager not available');
}
```

## Common Use Cases

### 1. User API Key Management

Let users store their personal API keys securely:

```typescript
// Action: Store user's OpenAI API key
export const storeApiKeyAction: Action = {
  name: 'STORE_API_KEY',

  handler: async (runtime, message) => {
    const secretsManager = runtime.getService('SECRETS') as EnhancedSecretManager;

    // Extract API key from message (e.g., "my openai key is sk-...")
    const match = message.content.text.match(/key is (sk-[\w-]+)/i);
    if (!match) {
      return { text: 'Please provide your API key in the format: "my key is sk-..."' };
    }

    const apiKey = match[1];
    const context: SecretContext = {
      level: 'user',
      userId: message.entityId,
      agentId: runtime.agentId,
      requesterId: message.entityId,
    };

    const success = await secretsManager.set('OPENAI_API_KEY', apiKey, context, {
      type: 'api_key',
      description: 'OpenAI API Key',
      encrypted: true,
      required: true,
    });

    return {
      text: success
        ? 'Your API key has been securely stored!'
        : 'Failed to store API key. Please try again.',
    };
  },
};
```

### 2. Using User's API Key in Actions

```typescript
// Action that uses the user's stored API key
export const generateTextAction: Action = {
  name: 'GENERATE_TEXT',

  handler: async (runtime, message) => {
    const secretsManager = runtime.getService('SECRETS') as EnhancedSecretManager;

    // Get user's API key
    const context: SecretContext = {
      level: 'user',
      userId: message.entityId,
      agentId: runtime.agentId,
      requesterId: message.entityId,
    };

    const apiKey = await secretsManager.get('OPENAI_API_KEY', context);
    if (!apiKey) {
      return {
        text: 'Please set your OpenAI API key first by saying "my openai key is sk-..."',
      };
    }

    // Use the API key
    const openai = new OpenAI({ apiKey });
    const response = await openai.chat.completions.create({
      model: 'gpt-5',
      messages: [{ role: 'user', content: message.content.text }],
    });

    return { text: response.choices[0].message.content };
  },
};
```

### 3. World-Level Configuration

Store configuration that applies to an entire Discord server or channel:

```typescript
// Action: Configure webhook for a Discord server
export const configureWebhookAction: Action = {
  name: 'CONFIGURE_WEBHOOK',

  validate: async (runtime, message) => {
    // Check if user is admin/owner
    const world = await runtime.getWorld(message.roomId);
    const userRole = world?.metadata?.roles?.[message.entityId];
    return userRole === Role.OWNER || userRole === Role.ADMIN;
  },

  handler: async (runtime, message) => {
    const secretsManager = runtime.getService('SECRETS') as EnhancedSecretManager;

    // Extract webhook URL
    const match = message.content.text.match(/webhook[:\s]+(\S+)/i);
    if (!match) {
      return { text: 'Please provide a webhook URL' };
    }

    const context: SecretContext = {
      level: 'world',
      worldId: message.roomId,
      agentId: runtime.agentId,
      requesterId: message.entityId,
    };

    const success = await secretsManager.set('WEBHOOK_URL', match[1], context, {
      type: 'url',
      description: 'Discord webhook for notifications',
      encrypted: false,
    });

    return {
      text: success
        ? 'Webhook configured for this server!'
        : 'Failed to configure webhook. Are you an admin?',
    };
  },
};
```

### 4. Provider Using Multi-Level Secrets

```typescript
export const apiStatusProvider: Provider = {
  name: 'apiStatus',

  get: async (runtime, message) => {
    const secretsManager = runtime.getService('SECRETS') as EnhancedSecretManager;

    // Check user's personal API key first
    const userContext: SecretContext = {
      level: 'user',
      userId: message.entityId,
      agentId: runtime.agentId,
      requesterId: message.entityId,
    };

    let apiKey = await secretsManager.get('API_KEY', userContext);
    let keySource = 'personal';

    // Fall back to world-level key
    if (!apiKey) {
      const worldContext: SecretContext = {
        level: 'world',
        worldId: message.roomId,
        agentId: runtime.agentId,
        requesterId: message.entityId,
      };
      apiKey = await secretsManager.get('API_KEY', worldContext);
      keySource = 'server';
    }

    // Fall back to global key
    if (!apiKey) {
      const globalContext: SecretContext = {
        level: 'global',
        agentId: runtime.agentId,
        requesterId: message.entityId,
      };
      apiKey = await secretsManager.get('API_KEY', globalContext);
      keySource = 'global';
    }

    return {
      text: apiKey ? `Using ${keySource} API key` : 'No API key configured',
      values: {
        hasApiKey: !!apiKey,
        keySource: apiKey ? keySource : null,
      },
    };
  },
};
```

### 5. Migration Example

Migrate existing plugin to use the new system:

```typescript
// Old approach
export const oldAction: Action = {
  handler: async (runtime, message) => {
    const apiKey = runtime.getSetting('MY_API_KEY');
    // Use API key...
  },
};

// New approach with backward compatibility
export const newAction: Action = {
  handler: async (runtime, message) => {
    // Try old way first for compatibility
    let apiKey = runtime.getSetting('MY_API_KEY');

    // Then try new way
    if (!apiKey) {
      const secretsManager = runtime.getService('SECRETS') as EnhancedSecretManager;
      const context: SecretContext = {
        level: 'global',
        agentId: runtime.agentId,
        requesterId: runtime.agentId,
      };
      apiKey = await secretsManager.get('MY_API_KEY', context);
    }

    // Use API key...
  },
};
```

### 6. Secret Sharing Between Users

```typescript
// Action: Share API access with another user
export const shareAccessAction: Action = {
  name: 'SHARE_ACCESS',

  handler: async (runtime, message) => {
    const secretsManager = runtime.getService('SECRETS') as EnhancedSecretManager;

    // Parse command: "share my API_KEY with @username"
    const match = message.content.text.match(/share my (\w+) with @(\w+)/i);
    if (!match) {
      return { text: 'Usage: share my SECRET_NAME with @username' };
    }

    const [_, secretKey, username] = match;

    // Get user ID from username (this is platform-specific)
    const targetUserId = await getUserIdFromUsername(username);

    const context: SecretContext = {
      level: 'user',
      userId: message.entityId,
      agentId: runtime.agentId,
      requesterId: message.entityId,
    };

    const success = await secretsManager.grantAccess(secretKey, context, targetUserId, ['read']);

    return {
      text: success
        ? `Shared ${secretKey} with @${username}`
        : 'Failed to share access. Do you own this secret?',
    };
  },
};
```

## Best Practices

### 1. Always Use Encryption for Sensitive Data

```typescript
// Good - encrypted by default for user secrets
await secretsManager.set(key, value, userContext);

// Good - explicitly encrypted
await secretsManager.set(key, value, context, { encrypted: true });

// Bad - storing API key without encryption
await secretsManager.set(key, apiKey, context, { encrypted: false });
```

### 2. Handle Missing Secrets Gracefully

```typescript
const apiKey = await secretsManager.get('API_KEY', context);
if (!apiKey) {
  // Provide helpful guidance
  return {
    text: 'To use this feature, please set your API key by saying "set my API key to sk-..."',
  };
}
```

### 3. Use Appropriate Secret Levels

```typescript
// User-specific data (personal API keys, preferences)
const userContext: SecretContext = {
  level: 'user',
  userId: message.entityId,
  // ...
};

// Server/channel configuration
const worldContext: SecretContext = {
  level: 'world',
  worldId: message.roomId,
  // ...
};

// Agent-wide configuration
const globalContext: SecretContext = {
  level: 'global',
  // ...
};
```

### 4. Validate Before Storing

```typescript
// Validate API key format
if (!apiKey.startsWith('sk-')) {
  return { text: 'Invalid API key format' };
}

// Use built-in validation
await secretsManager.set('API_KEY', apiKey, context, {
  type: 'api_key',
  validationMethod: 'openai',
});
```

### 5. Implement Proper Error Handling

```typescript
try {
  const success = await secretsManager.set(key, value, context);
  if (!success) {
    // Handle permission errors
    return { text: 'You do not have permission to set this secret' };
  }
} catch (error) {
  logger.error('Failed to set secret:', error);
  return { text: 'An error occurred while saving your secret' };
}
```

## Security Considerations

1. **Never log or expose secret values**

   ```typescript
   // Bad
   logger.info(`API Key: ${apiKey}`);

   // Good
   logger.info('API key retrieved successfully');
   ```

2. **Always verify permissions**

   ```typescript
   // The service checks permissions automatically, but you can add extra checks
   const world = await runtime.getWorld(message.roomId);
   const isAdmin = world?.metadata?.roles?.[message.entityId] === Role.ADMIN;
   ```

3. **Use components for user isolation**

   - User secrets are automatically isolated using the component system
   - Each user can only access their own secrets

4. **Implement rate limiting**
   ```typescript
   // Track secret access in your action
   const accessCount = await trackAccess(message.entityId, 'secret_access');
   if (accessCount > 10) {
     return { text: 'Too many requests. Please try again later.' };
   }
   ```
