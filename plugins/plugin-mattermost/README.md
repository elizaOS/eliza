# @elizaos/plugin-mattermost

Mattermost integration plugin for elizaOS agents. This plugin enables your agents to communicate through Mattermost channels, supporting direct messages, group messages, and channel conversations.

## Features

- **REST API & WebSocket Support**: Full Mattermost API integration with real-time messaging via WebSocket
- **Bot Token Authentication**: Secure authentication using Mattermost bot tokens
- **Multiple Message Types**: Support for DMs, channels, group messages, and threads
- **Media Attachments**: Upload and send file attachments
- **Configurable Policies**: Fine-grained control over DM and group message handling
- **Multi-Language**: Implementations in TypeScript, Rust, and Python

## Installation

```bash
# Using npm
npm install @elizaos/plugin-mattermost

# Using bun
bun add @elizaos/plugin-mattermost
```

## Configuration

Set the following environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `MATTERMOST_SERVER_URL` | Yes | Base URL for your Mattermost server (e.g., `https://chat.example.com`) |
| `MATTERMOST_BOT_TOKEN` | Yes | Bot token for authentication |
| `MATTERMOST_TEAM_ID` | No | Default team ID |
| `MATTERMOST_ENABLED` | No | Enable/disable the plugin (default: `true`) |
| `MATTERMOST_DM_POLICY` | No | DM policy: `pairing`, `allowlist`, `open`, or `disabled` (default: `pairing`) |
| `MATTERMOST_GROUP_POLICY` | No | Group policy: `allowlist`, `open`, or `disabled` (default: `allowlist`) |
| `MATTERMOST_ALLOWED_USERS` | No | JSON array of allowed user IDs or usernames |
| `MATTERMOST_ALLOWED_CHANNELS` | No | JSON array of allowed channel IDs |
| `MATTERMOST_REQUIRE_MENTION` | No | Require @mention to respond in channels (default: `true`) |
| `MATTERMOST_IGNORE_BOT_MESSAGES` | No | Ignore messages from other bots (default: `true`) |

## Usage

### TypeScript

```typescript
import mattermostPlugin from "@elizaos/plugin-mattermost";

// Add to your agent's plugins
const agent = new Agent({
  plugins: [mattermostPlugin],
  // ... other config
});
```

### Rust

```rust
use elizaos_plugin_mattermost::{MattermostConfig, MattermostService};

// Create config
let config = MattermostConfig::from_env()?;

// Create and start service
let mut service = MattermostService::new(config);
service.start().await?;

// Send a message
service.send_message("channel_id", "Hello, Mattermost!", None).await?;
```

### Python

```python
from elizaos_plugin_mattermost import MattermostConfig, MattermostService

# Create config
config = MattermostConfig.from_env()

# Create and start service
service = MattermostService(config)
await service.start()

# Send a message
from elizaos_plugin_mattermost import MattermostContent
content = MattermostContent(text="Hello, Mattermost!")
await service.send_message("channel_id", content)
```

## DM and Group Policies

### DM Policy

- `pairing`: Users must complete a pairing process before DMs are accepted
- `allowlist`: Only users in the allowed list can send DMs
- `open`: Accept DMs from anyone
- `disabled`: Don't accept any DMs

### Group Policy

- `allowlist`: Only messages from users in the allowed list are processed
- `open`: Process messages from anyone in the channel
- `disabled`: Don't process any channel messages

## Actions

### SEND_MATTERMOST_MESSAGE

Send a message to a Mattermost channel or user.

```typescript
// The action is automatically triggered when the agent responds in Mattermost context
```

## Providers

### mattermost_chat_state

Provides context about the current Mattermost conversation:

- `channel_id`: Current channel ID
- `user_id`: Sender's user ID
- `team_id`: Team ID
- `channel_type`: D (direct), G (group), O (open channel), P (private channel)
- `is_dm`: Whether this is a direct message
- `is_thread`: Whether this is a thread reply

## Development

### Building

```bash
# Build all implementations
bun run build

# Build TypeScript only
bun run build:ts

# Build Rust only
bun run build:rust

# Build Python only
bun run build:python
```

### Testing

```bash
# Run all tests
bun run test

# Run TypeScript tests
bun run test:ts

# Run Rust tests
bun run test:rust

# Run Python tests
bun run test:python
```

### Linting

```bash
# Lint all
bun run lint

# Lint TypeScript
bun run lint:check

# Lint Rust
bun run lint:rust

# Lint Python
bun run lint:python
```

## Creating a Mattermost Bot

1. Go to your Mattermost server's System Console
2. Navigate to **Integrations > Bot Accounts**
3. Click **Add Bot Account**
4. Fill in the bot details and select appropriate permissions
5. Copy the generated bot token

## License

MIT
