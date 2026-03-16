# elizaOS Plugin - Secrets Manager (Python)

Multi-level secrets management plugin for elizaOS with encryption, validation, and dynamic plugin activation.

## Features

- **Multi-level storage**: Global (agent-wide), World (server/channel), and User (per-user) secrets
- **Strong encryption**: AES-256-GCM encryption with secure key derivation
- **Validation**: Built-in validators for common API keys (OpenAI, Anthropic, Groq, etc.)
- **Dynamic activation**: Plugins can be activated once their required secrets are available
- **Access logging**: Track who accessed what secrets and when
- **Natural language**: Set and manage secrets via natural language commands

## Installation

```bash
pip install elizaos-plugin-secrets-manager
```

## Quick Start

```python
from elizaos_plugin_secrets_manager import secrets_manager_plugin, SecretsService

# Register the plugin with your runtime
runtime.register_plugin(secrets_manager_plugin)

# Or use the service directly
service = SecretsService(runtime)
await service.start()

# Set a global secret
await service.set_global("OPENAI_API_KEY", "sk-...")

# Get the secret
value = await service.get_global("OPENAI_API_KEY")
```

## Secret Levels

### Global Secrets
Agent-wide secrets like API keys that apply across all interactions.

```python
await service.set_global("OPENAI_API_KEY", "sk-...")
value = await service.get_global("OPENAI_API_KEY")
```

### World Secrets
Server/channel-specific secrets for multi-tenant scenarios.

```python
await service.set_world("ADMIN_TOKEN", "token-...", world_id="discord-server-123")
value = await service.get_world("ADMIN_TOKEN", world_id="discord-server-123")
```

### User Secrets
Per-user secrets for personalized configurations.

```python
await service.set_user("WALLET_ADDRESS", "0x...", user_id="user-123")
value = await service.get_user("WALLET_ADDRESS", user_id="user-123")
```

## Validation

Built-in validators ensure API keys match expected formats:

```python
from elizaos_plugin_secrets_manager import validate_secret

result = await validate_secret("OPENAI_API_KEY", "sk-abc123...", "openai")
if result.is_valid:
    print("Valid OpenAI key!")
else:
    print(f"Invalid: {result.error}")
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

## Plugin Activation

Register plugins that depend on secrets:

```python
from elizaos_plugin_secrets_manager import PluginActivatorService, PluginWithSecrets, PluginSecretRequirement

activator = PluginActivatorService(runtime)

# Define requirements
requirements = {
    "OPENAI_API_KEY": PluginSecretRequirement(
        key="OPENAI_API_KEY",
        description="OpenAI API key for completions",
        required=True,
        validation_method="openai"
    )
}

# Register plugin for activation
plugin_with_secrets = PluginWithSecrets(
    plugin=my_plugin,
    secret_requirements=requirements,
    on_secrets_ready=my_activation_callback
)

await activator.register_plugin(plugin_with_secrets)
```

## Actions

The plugin provides natural language actions:

### SET_SECRET
Set a secret via natural language:
> "Set my OpenAI key to sk-abc123xyz"

### MANAGE_SECRET
Manage secrets:
> "List all my secrets"
> "Delete my GROQ_API_KEY"
> "Is ANTHROPIC_API_KEY configured?"

## Encryption

All secrets are encrypted by default using AES-256-GCM:

```python
from elizaos_plugin_secrets_manager import KeyManager, encrypt, decrypt

# Key derivation
key_manager = KeyManager()
key_manager.initialize_from_agent_id("agent-123", "salt")

# Encrypt
encrypted = key_manager.encrypt("my secret")

# Decrypt
plaintext = key_manager.decrypt(encrypted)
```

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy elizaos_plugin_secrets_manager

# Linting
ruff check elizaos_plugin_secrets_manager
```

## License

MIT
