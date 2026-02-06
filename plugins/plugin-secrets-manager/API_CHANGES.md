# Secrets Manager API Changes

## Overview

The Secrets Manager plugin has been enhanced to support multi-level secret management (global, world, user) with encryption, access control, and multi-tenancy support. This document outlines the API changes and migration guide.

## Breaking Changes

### 1. Service Class Change

- **Old**: `EnvManagerService`
- **New**: `EnhancedSecretManager` (extends `EnvManagerService`)

The new service is backward compatible but adds significant new functionality.

### 2. Storage Locations

- **Global secrets**: Still in `character.settings.secrets` (backward compatible)
- **World secrets**: NEW - stored in `world.metadata.secrets`
- **User secrets**: NEW - stored as encrypted Components with type `'secret'`

## New APIs

### Secret Context

All secret operations now require a context to specify the level and permissions:

```typescript
interface SecretContext {
  level: 'global' | 'world' | 'user';
  worldId?: string; // Required for world-level
  userId?: string; // Required for user-level
  agentId: string;
  requesterId?: string; // Who is making the request
}
```

### Core Methods

#### Get a Secret

```typescript
// Old way (still works for global)
const value = runtime.getSetting('MY_KEY');

// New way
const secretManager = runtime.getService('SECRETS') as EnhancedSecretManager;
const value = await secretManager.get('MY_KEY', {
  level: 'user',
  userId: message.entityId,
  agentId: runtime.agentId,
  requesterId: message.entityId,
});
```

#### Set a Secret

```typescript
// Old way (character settings)
runtime.setSetting('MY_KEY', 'value');

// New way
await secretManager.set('MY_KEY', 'value', context, {
  type: 'api_key',
  description: 'My API Key',
  encrypted: true,
  required: true,
});
```

#### List Secrets

```typescript
// List all user secrets (without values)
const secrets = await secretManager.list({
  level: 'user',
  userId: message.entityId,
  agentId: runtime.agentId,
});
```

### New Actions

#### MANAGE_SECRET Action

Natural language interface for secret management:

```
User: "Set my API key as abc123"
User: "List all world-level secrets"
User: "Delete the webhook URL secret"
```

### New Providers

#### secretsInfo Provider

Provides information about available secrets at all levels:

```typescript
const info = await runtime.useProvider('secretsInfo');
// Returns counts and keys for global, world, and user secrets
```

## Permission Model

### Global Secrets

- **Read**: All entities can read
- **Write**: Only agent admin (agentId) can write

### World Secrets

- **Read**: All world members can read
- **Write**: Only OWNER and ADMIN roles can write

### User Secrets

- **Read/Write**: Only the user themselves

## Migration Guide

### Automatic Migration

Run the migration helper to automatically migrate existing settings:

```typescript
import { runMigration } from '@elizaos/plugin-env';

// In your plugin init
await runMigration(runtime);
```

### Manual Migration

#### 1. World Settings with `secret: true`

```typescript
// Old
world.metadata.settings[key] = {
  value: 'secret-value',
  secret: true,
  // ...
};

// New
await secretManager.set(
  key,
  'secret-value',
  {
    level: 'world',
    worldId: world.id,
    agentId: runtime.agentId,
  },
  {
    encrypted: true,
    // ...
  }
);
```

#### 2. Character Settings

```typescript
// Old
character.settings.MY_KEY = 'value';

// New
await secretManager.set('MY_KEY', 'value', {
  level: 'global',
  agentId: runtime.agentId,
});
```

## Backward Compatibility

### What Still Works

1. `runtime.getSetting()` - still reads from character settings
2. `EnvManagerService` methods - all still available
3. Existing env var actions and providers
4. Character settings storage

### Compatibility Layer

The migration helper can install a compatibility layer that makes `getSetting` check both old and new storage:

```typescript
const helper = new SecretMigrationHelper(runtime);
helper.installCompatibilityLayer();
```

## Best Practices

### 1. Use Appropriate Levels

- **Global**: Agent-wide settings (API keys for agent services)
- **World**: World-specific configurations (webhooks, channel settings)
- **User**: Personal secrets (user's own API keys, tokens)

### 2. Always Encrypt Sensitive Data

```typescript
await secretManager.set(key, value, context, {
  encrypted: true, // Default for user secrets
});
```

### 3. Use Natural Language Actions

Let users manage their own secrets through conversation:

```
User: "Set my OpenAI API key"
Agent: "Please provide your OpenAI API key."
User: "sk-..."
Agent: "I've securely stored your OpenAI API key."
```

### 4. Check Permissions

The service automatically checks permissions, but you can also check manually:

```typescript
const hasAccess = await secretManager.checkPermission(key, 'write', context);
```

## Security Considerations

1. **Encryption**: User secrets are encrypted by default using AES-256-GCM
2. **Access Logs**: All access attempts are logged for audit
3. **No Value Exposure**: The MANAGE_SECRET action never exposes actual secret values
4. **Component Isolation**: User secrets are stored in components, ensuring tenant isolation

## Examples

### Setting a User API Key

```typescript
const context: SecretContext = {
  level: 'user',
  userId: message.entityId,
  agentId: runtime.agentId,
  requesterId: message.entityId,
};

await secretManager.set('OPENAI_API_KEY', apiKey, context, {
  type: 'api_key',
  description: 'OpenAI API Key for ChatGPT',
  encrypted: true,
  required: true,
});
```

### World-Level Webhook Configuration

```typescript
const context: SecretContext = {
  level: 'world',
  worldId: message.roomId,
  agentId: runtime.agentId,
  requesterId: message.entityId,
};

// Only OWNER/ADMIN can set this
await secretManager.set('WEBHOOK_URL', url, context, {
  type: 'url',
  description: 'Webhook for notifications',
  encrypted: false,
});
```

### Granting Access to Another User

```typescript
await secretManager.grantAccess('MY_SECRET', context, otherUserId, ['read']);
```

## Troubleshooting

### Secret Not Found

1. Check the correct level is specified
2. Verify the requesterId has permission
3. Ensure the key name is correct (case-sensitive)

### Permission Denied

1. Global writes require agentId as requesterId
2. World writes require OWNER/ADMIN role
3. User secrets require matching userId and requesterId

### Migration Issues

1. Run migration in plugin init, not in actions
2. Check logs for specific migration errors
3. Manually verify world.metadata structure

## Future Enhancements

1. **Hierarchical Secrets**: Inherit from higher levels
2. **Secret Rotation**: Automatic rotation policies
3. **External Key Management**: Integration with KMS services
4. **Audit Reports**: Detailed access analytics
5. **Secret Sharing**: Secure sharing between users

---

## Web-Based Secret Collection

### Overview

The Enhanced Secrets Manager now includes web-based form collection capabilities using ngrok tunnels. This allows secure collection of secrets through web forms instead of messaging services.

### New Services

#### NgrokService

Manages secure ngrok tunnels for temporary form access:

```typescript
const ngrokService = runtime.getService('NGROK') as NgrokService;

// Create a tunnel
const tunnel = await ngrokService.createTunnel(port, 'secret-form', 30 * 60 * 1000);
// Returns: { id: string, url: string }

// Check tunnel status
const isActive = ngrokService.isTunnelActive(tunnelId);

// Close tunnel
await ngrokService.closeTunnel(tunnelId);
```

#### SecretFormService

Creates and manages secure web forms for secret collection:

```typescript
const formService = runtime.getService('SECRET_FORMS') as SecretFormService;

// Create a form
const request: SecretFormRequest = {
  secrets: [
    {
      key: 'API_KEY',
      config: {
        type: 'api_key',
        description: 'Your API Key',
        required: true,
        encrypted: true,
      },
    },
  ],
  title: 'API Configuration',
  description: 'Please provide your API credentials',
  mode: 'requester', // or 'inline'
  expiresIn: 30 * 60 * 1000, // 30 minutes
};

const context: SecretContext = {
  level: 'user',
  userId: message.entityId,
  agentId: runtime.agentId,
};

const { url, sessionId } = await formService.createSecretForm(
  request,
  context,
  async (submission) => {
    // Optional callback when form is submitted
    console.log('Form submitted:', submission.data);
  }
);
```

### New Action

#### REQUEST_SECRET_FORM

Natural language action for requesting secrets through web forms:

```typescript
// User: "I need you to collect my OpenAI and Anthropic API keys"
// Assistant: "I'll create a secure form for you to provide your API keys."
// -> Creates form with fields for both API keys
// -> Returns secure ngrok URL for user to visit
```

### Form Types and Presets

The system includes presets for common secret types:

```typescript
// Available form field types
type FormFieldType =
  | 'text'
  | 'password'
  | 'email'
  | 'tel'
  | 'number'
  | 'url'
  | 'textarea'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'file'
  | 'date'
  | 'creditcard'
  | 'json'
  | 'code';

// Preset configurations
FormFieldPresets.apiKey; // Password field with min length validation
FormFieldPresets.email; // Email field with pattern validation
FormFieldPresets.webhookUrl; // URL field with https validation
FormFieldPresets.creditCard; // Credit card field with Luhn validation
FormFieldPresets.privateKey; // Textarea for keys
FormFieldPresets.jsonConfig; // Code editor with JSON validation
```

### Security Features

1. **Temporary Tunnels**: Forms are only accessible for a limited time
2. **Single Submission**: Forms accept only one submission by default
3. **Auto-cleanup**: Forms and tunnels are automatically cleaned up
4. **Browser Security**: Data is cleared from browser after submission
5. **HTTPS Only**: All form access is over secure connections

### Example: Multi-Secret Form

```typescript
// Create a comprehensive configuration form
const request: SecretFormRequest = {
  secrets: [
    {
      key: 'OPENAI_API_KEY',
      config: { type: 'api_key', description: 'OpenAI API Key' },
    },
    {
      key: 'WEBHOOK_URL',
      config: { type: 'url', description: 'Webhook Endpoint' },
    },
    {
      key: 'CONFIG_JSON',
      config: { type: 'config', description: 'Additional Configuration' },
    },
  ],
  title: 'Service Configuration',
  description: 'Configure your AI service integration',
  maxSubmissions: 1,
  expiresIn: 30 * 60 * 1000,
};
```

### Testing

E2E tests are included using Puppeteer:

```bash
# Run all secret form tests
elizaos test --name "Secret Forms E2E Tests"

# Tests include:
# - Form creation and submission
# - Multiple field handling
# - Form expiration
# - Validation testing
# - Ngrok tunnel management
```

### Configuration

Required environment variables:

```env
# Optional: For authenticated ngrok tunnels
NGROK_AUTH_TOKEN=your_ngrok_auth_token
```

### Migration Notes

The web form system is fully additive - no breaking changes:

1. Existing secret storage continues to work
2. Forms integrate seamlessly with EnhancedSecretManager
3. Secrets collected via forms use the same storage system
4. All existing APIs remain unchanged
