# @elizaos/plugin-roblox

Roblox plugin for elizaOS v2.0.0 - Enables AI agents to communicate with Roblox games via the Open Cloud API.

## Features

- **Messaging Service**: Cross-server communication with Roblox games
- **DataStore Operations**: Persistent data storage for agents
- **Player Management**: Look up player information by ID or username
- **Game Actions**: Execute custom actions in-game
- **Experience Info**: Retrieve game metadata and statistics

## Installation

### TypeScript

```bash
npm install @elizaos/plugin-roblox
# or
bun add @elizaos/plugin-roblox
```
## Quick Start

### TypeScript (elizaOS)

```typescript
import { robloxPlugin } from "@elizaos/plugin-roblox";

// Add to your agent configuration
const agent = {
  plugins: [robloxPlugin],
  // ... other config
};
```

### Environment Variables

| Variable                 | Required | Description                              |
| ------------------------ | -------- | ---------------------------------------- |
| `ROBLOX_API_KEY`         | Yes      | Roblox Open Cloud API key                |
| `ROBLOX_UNIVERSE_ID`     | Yes      | Universe ID of your experience           |
| `ROBLOX_PLACE_ID`        | No       | Specific place ID                        |
| `ROBLOX_WEBHOOK_SECRET`  | No       | Secret for webhook validation            |
| `ROBLOX_MESSAGING_TOPIC` | No       | Messaging topic (default: "eliza-agent") |
| `ROBLOX_DRY_RUN`         | No       | Enable dry run mode (default: false)     |

## Action

### ROBLOX_ACTION

Route Roblox game integration through one compact action surface.

Supported subactions:

- `message`: send a message to all players or target player IDs
- `execute`: publish a game-side action payload such as `spawn_entity`, `give_coins`, or `teleport`
- `get_player`: look up Roblox player information by username or user ID

**Examples:**

- "Tell everyone in the game that there's a special event happening"
- "Give player456 100 coins as a reward"
- "Who is player 12345678?"

## Providers

### roblox-game-state

Provides information about the connected Roblox experience to the agent's context:

- Universe ID and Place ID
- Experience name and statistics
- Active player count
- Creator information
- Messaging topic configuration

## Services

### RobloxService

Main service for managing Roblox connections and communication:

```typescript
import { RobloxService, ROBLOX_SERVICE_NAME } from "@elizaos/plugin-roblox";

// Get service from runtime
const service = runtime.getService<RobloxService>(ROBLOX_SERVICE_NAME);

// Send a message to all players
await service.sendMessage(runtime.agentId, "Hello from Eliza!");

// Execute a game action
await service.executeAction(
  runtime.agentId,
  "spawn_item",
  { item: "sword", rarity: "legendary" },
  [12345678], // Target specific player
);
```

## Roblox Game Integration

To receive messages from your Roblox game, you'll need to set up a Luau script that listens to the Messaging Service:

```lua
-- Server script in Roblox Studio
local MessagingService = game:GetService("MessagingService")

local TOPIC = "eliza-agent" -- Must match ROBLOX_MESSAGING_TOPIC

MessagingService:SubscribeAsync(TOPIC, function(message)
    local data = game:GetService("HttpService"):JSONDecode(message.Data)

    if data.type == "agent_message" then
        -- Handle agent message
        print("Agent says:", data.content)
        -- Broadcast to players, show in chat, etc.
    elseif data.type == "agent_action" then
        -- Handle agent action
        print("Agent action:", data.action, data.parameters)
        -- Execute the action in-game
    end
end)
```

## Limitations & recommended architecture (critical notes)

### Inbound messages (Roblox → agent)

Roblox Open Cloud **does not provide an external “subscribe” API** for `MessagingService`. That means:

- This plugin supports **agent → Roblox** (publish) reliably.
- It cannot, by itself, “listen to player chat” from outside Roblox by polling Open Cloud.

**Recommended approach**: run a small HTTP bridge server that Roblox calls via `HttpService:RequestAsync(...)` and let the agent respond. See `examples/roblox/`.

### Movement / “walking around”

Agents cannot move things in Roblox via Open Cloud directly. Movement is possible only when your Roblox experience:

- subscribes to the topic
- interprets `agent_action` payloads (e.g. `move_npc`, `teleport`)
- performs the movement using Roblox APIs (Humanoid / Pathfinding / TeleportService)

### Voice

Open Cloud does not provide a direct “agent voice” channel.

- You can generate audio externally, but Roblox playback requires game-side logic and Roblox’s audio constraints (assets / permissions / allowed sources).
- Most deployments start with **text** and add voice later with custom UI and an audio pipeline.

## Project Structure

```
plugin-roblox/
├── typescript/          # TypeScript implementation
│   ├── actions/         # ROBLOX_ACTION router
│   ├── services/        # RobloxService
│   ├── providers/       # Context providers
│   ├── client/          # API client
│   ├── types/           # Type definitions
│   └── index.ts         # Plugin entry point
├── rust/                # Rust implementation
│   └── src/
│       ├── client.rs    # API client
│       ├── service.rs   # Service implementation
│       └── lib.rs       # Crate entry point
├── python/              # Python implementation
│   └── elizaos_plugin_roblox/
│       ├── client.py    # API client
│       ├── service.py   # Service implementation
│       └── __init__.py  # Package entry point
└── package.json         # npm package configuration
```

## Development

### Building

```bash
# TypeScript
bun run build
# TypeScript
bun run test
# TypeScript
bun run lint
