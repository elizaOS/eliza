# @elizaos/plugin-tlon

Tlon/Urbit integration plugin for elizaOS agents. This plugin enables agents to communicate via the Urbit network using the Tlon messaging protocol.

## Features

- **Direct Messages (DMs)**: Send and receive direct messages with other Urbit ships
- **Group Channels**: Participate in group chat channels
- **Thread Replies**: Reply to specific messages in threads
- **Real-time Streaming**: SSE-based real-time message streaming
- **Channel Authorization**: Control which ships can interact with your agent
- **Auto-discovery**: Automatically discover available channels

## Installation

```bash
# TypeScript
npm install @elizaos/plugin-tlon

# Python
pip install elizaos-plugin-tlon

# Rust
cargo add elizaos-plugin-tlon
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TLON_SHIP` | Yes | Your Urbit ship name (e.g., `~sampel-palnet`) |
| `TLON_URL` | Yes | URL of your Urbit ship's HTTP API |
| `TLON_CODE` | Yes | Authentication code from `+code` in dojo |
| `TLON_ENABLED` | No | Enable/disable the plugin (default: `true`) |
| `TLON_GROUP_CHANNELS` | No | JSON array of channel nests to monitor |
| `TLON_DM_ALLOWLIST` | No | JSON array of ships allowed to send DMs |
| `TLON_AUTO_DISCOVER_CHANNELS` | No | Auto-discover channels (default: `true`) |

### Example Configuration

```env
TLON_SHIP=~sampel-palnet
TLON_URL=https://sampel-palnet.tlon.network
TLON_CODE=lidlut-tabwed-pillex-ridrup
TLON_ENABLED=true
TLON_GROUP_CHANNELS=["chat/~host-ship/channel-name"]
TLON_DM_ALLOWLIST=["~zod", "~bus"]
TLON_AUTO_DISCOVER_CHANNELS=true
```

## Usage

### TypeScript

```typescript
import tlonPlugin, { TlonService } from '@elizaos/plugin-tlon';

// Add to your agent's plugins
const agent = {
  plugins: [tlonPlugin],
  // ...
};

// Or use the service directly
const service = new TlonService(runtime);
await TlonService.start(runtime);

// Send a DM
await service.sendDirectMessage('~sampel-palnet', 'Hello from my agent!');

// Send a channel message
await service.sendChannelMessage(
  'chat/~host-ship/channel-name',
  'Hello channel!',
  'optional-reply-to-id'
);
```

### Python

```python
from elizaos_plugin_tlon import TlonService, TlonConfig

# Create configuration
config = TlonConfig.from_env()

# Or configure manually
config = TlonConfig(
    ship="sampel-palnet",
    url="https://sampel-palnet.tlon.network",
    code="lidlut-tabwed-pillex-ridrup",
)

# Start the service
service = TlonService(config)
await service.start()

# Send messages
await service.send_dm("~other-ship", "Hello!")
await service.send_channel_message("chat/~host/channel", "Hello channel!")

# Register message handlers
@service.on_message
def handle_message(payload):
    print(f"Received: {payload.text} from {payload.from_ship.name}")
```

### Rust

```rust
use elizaos_plugin_tlon::{TlonConfig, TlonService};

// Create configuration
let config = TlonConfig::from_env()?;

// Or configure manually
let config = TlonConfig::new(
    "sampel-palnet".to_string(),
    "https://sampel-palnet.tlon.network".to_string(),
    "lidlut-tabwed-pillex-ridrup".to_string(),
);

// Start the service
let mut service = TlonService::new(config);
service.start().await?;

// Send messages
service.send_dm("other-ship", "Hello!").await?;
service.send_channel_message("chat/~host/channel", "Hello!", None).await?;
```

## Urbit Concepts

### Ships

Urbit ships are identified by their `@p` names, which look like `~sampel-palnet`. Ships can be:
- **Galaxies**: 8-bit names like `~zod`
- **Stars**: 16-bit names like `~marzod`
- **Planets**: 32-bit names like `~sampel-palnet`
- **Moons**: 64-bit names derived from planets

### Channels

Tlon organizes messages into channels. Channel nests follow the format:
```
<type>/<host-ship>/<channel-name>
```

For example: `chat/~sampel-palnet/general`

### Authentication

To get your authentication code:
1. Open your ship's dojo
2. Run `+code`
3. Copy the resulting code (e.g., `lidlut-tabwed-pillex-ridrup`)

## API Reference

### TlonService

The main service class for interacting with Tlon/Urbit.

#### Methods

- `start()` - Start the service and connect to the Urbit ship
- `stop()` - Stop the service and disconnect
- `sendDirectMessage(ship, text)` - Send a DM to a ship
- `sendChannelMessage(channelNest, text, replyToId?)` - Send a message to a channel
- `isConnected()` - Check if the service is connected

### TlonClient

Lower-level HTTP API client for direct Urbit interaction.

#### Methods

- `authenticate(url, code)` - Authenticate with a ship
- `subscribe(params)` - Subscribe to an app's path
- `poke(params)` - Send a poke to an app
- `scry(path)` - Perform a read-only query
- `connect()` - Connect and start receiving events
- `close()` - Close the connection

## Events

The plugin emits the following events:

| Event | Description |
|-------|-------------|
| `TLON_WORLD_CONNECTED` | Successfully connected to ship |
| `TLON_WORLD_LEFT` | Disconnected from ship |
| `TLON_MESSAGE_RECEIVED` | Any message received |
| `TLON_DM_RECEIVED` | Direct message received |
| `TLON_GROUP_MESSAGE_RECEIVED` | Group channel message received |
| `TLON_CONNECTION_ERROR` | Connection error occurred |
| `TLON_RECONNECTED` | Successfully reconnected |

## Development

```bash
# Build all implementations
npm run build

# Run tests
npm run test

# TypeScript only
npm run build:ts
npm run test:ts

# Rust only
npm run build:rust
npm run test:rust

# Python only
npm run build:python
npm run test:python
```

## License

MIT
