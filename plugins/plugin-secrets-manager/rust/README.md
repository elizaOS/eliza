# elizaOS Plugin - Secrets Manager (Rust)

Multi-level secrets management plugin for elizaOS with encryption, validation, and dynamic plugin activation.

## Features

- **Multi-level storage**: Global (agent-wide), World (server/channel), and User (per-user) secrets
- **Strong encryption**: AES-256-GCM encryption with secure key derivation
- **Validation**: Built-in validators for common API keys (OpenAI, Anthropic, Groq, etc.)
- **Access logging**: Track who accessed what secrets and when
- **Async/await**: Full async support with tokio

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-secrets-manager = "0.1"
```

## Quick Start

```rust
use elizaos_plugin_secrets_manager::{SecretsService, SecretsServiceConfig};

#[tokio::main]
async fn main() {
    // Create the service
    let service = SecretsService::new("agent-123", SecretsServiceConfig::default());
    service.start().await.unwrap();

    // Set a global secret
    service.set_global("OPENAI_API_KEY", "sk-...", None).await.unwrap();

    // Get the secret
    let value = service.get_global("OPENAI_API_KEY").await.unwrap();
    println!("API Key: {:?}", value);

    service.stop().await.unwrap();
}
```

## Secret Levels

### Global Secrets
Agent-wide secrets like API keys that apply across all interactions.

```rust
service.set_global("OPENAI_API_KEY", "sk-...", None).await?;
let value = service.get_global("OPENAI_API_KEY").await?;
```

### World Secrets
Server/channel-specific secrets for multi-tenant scenarios.

```rust
service.set_world("ADMIN_TOKEN", "token-...", "discord-server-123", None).await?;
let value = service.get_world("ADMIN_TOKEN", "discord-server-123").await?;
```

### User Secrets
Per-user secrets for personalized configurations.

```rust
service.set_user("WALLET_ADDRESS", "0x...", "user-123", None).await?;
let value = service.get_user("WALLET_ADDRESS", "user-123").await?;
```

## Context-Based Access

For more control, use `SecretContext`:

```rust
use elizaos_plugin_secrets_manager::SecretContext;

// Global context
let ctx = SecretContext::global("agent-123");

// World context
let ctx = SecretContext::world("agent-123", "world-456");

// User context with requester
let ctx = SecretContext::user("agent-123", "user-789", Some("requester-id".to_string()));

// Use with service
service.set("API_KEY", "value", &ctx, None).await?;
let value = service.get("API_KEY", &ctx).await?;
```

## Validation

Built-in validators ensure API keys match expected formats:

```rust
use elizaos_plugin_secrets_manager::validate_secret;

let result = validate_secret("OPENAI_API_KEY", "sk-abc123...", Some("openai"));
if result.is_valid {
    println!("Valid OpenAI key!");
} else {
    println!("Invalid: {:?}", result.error);
}
```

Supported validators:
- `openai` - OpenAI API keys (sk-...)
- `anthropic` - Anthropic API keys (sk-ant-...)
- `groq` - Groq API keys (gsk_...)
- `google` / `gemini` - Google API keys
- `discord` - Discord bot tokens
- `telegram` - Telegram bot tokens
- `github` - GitHub tokens
- `url` - URL validation

### Custom Validators

Register custom validation strategies:

```rust
use elizaos_plugin_secrets_manager::{register_validator, ValidationResult};

fn custom_validator(_key: &str, value: &str) -> ValidationResult {
    if value.starts_with("custom_") {
        ValidationResult::valid()
    } else {
        ValidationResult::invalid("Must start with custom_")
    }
}

register_validator("custom", custom_validator);
```

## Encryption

All secrets are encrypted by default using AES-256-GCM:

```rust
use elizaos_plugin_secrets_manager::{KeyManager, encrypt, decrypt, generate_key};

// Generate a random key
let key = generate_key();

// Or derive from agent ID (compatible with TS/Python versions)
let mut key_manager = KeyManager::new();
key_manager.initialize_from_agent_id("agent-123", "salt");

// Encrypt
let encrypted = key_manager.encrypt("my secret")?;

// Decrypt
let plaintext = key_manager.decrypt(&encrypted)?;
```

## Plugin Requirements

Check if secrets are available for a plugin:

```rust
use elizaos_plugin_secrets_manager::PluginSecretRequirement;
use std::collections::HashMap;

let mut requirements = HashMap::new();
requirements.insert(
    "OPENAI_API_KEY".to_string(),
    PluginSecretRequirement::required("OPENAI_API_KEY", "OpenAI API key")
        .with_validation("openai"),
);
requirements.insert(
    "OPTIONAL_KEY".to_string(),
    PluginSecretRequirement::optional("OPTIONAL_KEY", "Optional configuration"),
);

let status = service.check_plugin_requirements("my-plugin", &requirements).await?;
if status.ready {
    println!("All required secrets available!");
} else {
    println!("Missing: {:?}", status.missing_required);
}
```

## Access Logging

Track secret access for audit purposes:

```rust
// Get all access logs
let logs = service.get_access_logs(None, None, None).await;

// Filter by key
let logs = service.get_access_logs(Some("OPENAI_API_KEY"), None, None).await;

// Filter by action type
use elizaos_plugin_secrets_manager::SecretPermissionType;
let logs = service.get_access_logs(None, Some(SecretPermissionType::Write), None).await;

// Filter by timestamp
let logs = service.get_access_logs(None, None, Some(timestamp)).await;

// Clear logs
service.clear_access_logs().await;
```

## Change Notifications

Subscribe to secret changes:

```rust
use std::sync::Arc;

// Subscribe to specific key changes
service.on_secret_changed("OPENAI_API_KEY", Arc::new(|key, value, context| {
    println!("Secret {} changed", key);
})).await;

// Subscribe to all changes
service.on_any_secret_changed(Arc::new(|key, value, context| {
    println!("Some secret changed: {}", key);
})).await;
```

## Error Handling

The crate uses a custom `SecretsError` type:

```rust
use elizaos_plugin_secrets_manager::{SecretsError, SecretsResult};

match service.get("KEY", &context).await {
    Ok(Some(value)) => println!("Got: {}", value),
    Ok(None) => println!("Not found"),
    Err(SecretsError::ValidationFailed { key, reason }) => {
        println!("Validation failed for {}: {}", key, reason);
    }
    Err(e) => println!("Error: {}", e),
}
```

## License

MIT
