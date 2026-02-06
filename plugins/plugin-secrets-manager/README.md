# Environment Variable Management Plugin

A comprehensive environment variable management system for autonomous agents that provides automatic detection, generation, validation, and user interaction for environment variables.

## Features

- 🔍 **Automatic Detection**: Scans plugins and character settings for required environment variables
- 🤖 **Auto-Generation**: Automatically generates variables that can be created programmatically (keys, secrets, UUIDs, etc.)
- ✅ **Validation**: Tests environment variables to ensure they work correctly with their intended services
- 👤 **User Interaction**: Requests user input for variables that cannot be auto-generated (API keys, etc.)
- 💾 **Persistent Storage**: Stores configuration in world metadata following the same pattern as settings
- 🔄 **Runtime Updates**: Updates environment variables without requiring agent restart

## Architecture

The plugin follows the established patterns in the codebase:

- **Service**: `EnvManagerService` - Manages environment variable lifecycle
- **Provider**: `envStatusProvider` - Shows current status of all environment variables
- **Actions**: `setEnvVarAction`, `generateEnvVarAction` - Handle user input and auto-generation
- **Storage**: Uses `world.metadata.envVars` following the same pattern as settings and roles

## Components

### EnvManagerService

The core service that:

- Scans character settings and plugins for required environment variables
- Maintains metadata about variable types, requirements, and status
- Provides methods to query and update environment variables
- Integrates with the shell service for script execution

### Environment Status Provider

Provides comprehensive status information:

- Lists all environment variables by plugin
- Shows which variables are missing, valid, or invalid
- Indicates which variables can be auto-generated
- Provides recommendations for next steps

### Set Environment Variable Action

Handles user input for environment variables:

- Extracts variable assignments from natural language
- Validates and updates multiple variables at once
- Provides feedback on validation results
- Guides users through the configuration process

### Generate Environment Variable Action

Automatically generates variables when possible:

- Creates cryptographic keys (RSA, Ed25519)
- Generates secrets (JWT secrets, encryption keys, UUIDs)
- Handles dependency installation for generation scripts
- Validates generated values before setting them

## Supported Variable Types

### Auto-Generatable

- **Private Keys**: RSA, Ed25519 cryptographic keys
- **Secrets**: JWT secrets, encryption keys, session secrets
- **UUIDs**: Unique identifiers
- **Config Values**: Port numbers, database names

### User-Required

- **API Keys**: OpenAI, Groq, Anthropic, Twitter, Discord, etc.
- **Tokens**: Authentication tokens from external services
- **URLs**: Webhook endpoints, API endpoints
- **Credentials**: Database URLs, service credentials

## Usage Examples

### Agent Interaction

```
Agent: "I've detected that the OpenAI plugin requires OPENAI_API_KEY. I can auto-generate
        some variables, but this one needs to be provided by you. You can get an API key
        from https://platform.openai.com/"

User: "Set OPENAI_API_KEY to sk-1234567890abcdef"

Agent: "✅ OPENAI_API_KEY validated successfully! The OpenAI plugin is now configured
        and ready to use."
```

### Auto-Generation

```
Agent: "I need to set up some security keys. Let me generate those automatically..."

Agent: "🎉 Successfully generated 3 environment variables!
        ✅ JWT_SECRET: Generated and validated successfully
        ✅ ENCRYPTION_KEY: Generated and validated successfully
        ✅ SESSION_SECRET: Generated and validated successfully"
```

## Configuration

Environment variables are stored in `world.metadata.envVars` with the following structure:

```typescript
{
  [pluginName]: {
    [variableName]: {
      value?: string;
      type: 'api_key' | 'private_key' | 'secret' | 'config' | 'url' | 'credential';
      required: boolean;
      description: string;
      canGenerate: boolean;
      status: 'missing' | 'generating' | 'validating' | 'invalid' | 'valid';
      attempts: number;
      createdAt: number;
      validatedAt?: number;
      lastError?: string;
    }
  }
}
```

## Validation Strategies

The plugin includes validation strategies for different variable types:

- **API Keys**: Test actual API calls to verify functionality
- **Private Keys**: Validate format and test encryption/decryption
- **URLs**: Check connectivity and response codes
- **Credentials**: Validate format and basic connectivity

## Security Features

- **Encrypted Storage**: Sensitive values are handled securely
- **Audit Trail**: All changes are logged with timestamps
- **Validation**: Variables are tested before being marked as valid
- **Sandboxing**: Generation scripts run in isolated environments
- **No Logging**: Sensitive values are never logged in full

## Integration

The plugin integrates seamlessly with:

- **Shell Service**: For executing generation scripts
- **Character Settings**: Scans character.settings.secrets
- **Plugin System**: Detects requirements from loaded plugins
- **World Metadata**: Persistent storage following established patterns

## Error Handling

Comprehensive error handling includes:

- **Generation Failures**: Retry with different approaches, fallback to user input
- **Validation Failures**: Clear error messages with troubleshooting guidance
- **User Input Errors**: Format validation with helpful examples
- **Service Failures**: Graceful degradation with informative messages

## Future Enhancements

Potential future improvements:

- **Plugin Manifest Scanning**: Automatic detection from plugin.json files
- **Environment Profiles**: Different configurations for dev/staging/prod
- **Backup/Restore**: Export/import environment configurations
- **Rotation**: Automatic key rotation for security
- **Monitoring**: Health checks and expiration warnings

## Development

To extend the plugin:

1. **Add Variable Types**: Update `types.ts` and generation templates
2. **Add Validation**: Implement new validation strategies in `validation.ts`
3. **Add Generation**: Create new script templates in `generation.ts`
4. **Test**: Use the existing test patterns for new functionality

The plugin is designed to be extensible and follows the established patterns in the Eliza codebase for consistency and maintainability.
