# @elizaos/plugin-roblox

Roblox Open Cloud integration for elizaOS agents: publish messages and game-side
action payloads to a Roblox experience, and look up Roblox players. Communication
is outbound (agent → Roblox); Open Cloud has no external subscribe endpoint, so
inbound player chat must be bridged from Roblox (see below).

## Install

```bash
bun add @elizaos/plugin-roblox
# or
npm install @elizaos/plugin-roblox
```

## Use

```typescript
import { robloxPlugin } from "@elizaos/plugin-roblox";

const agent = {
  plugins: [robloxPlugin],
  // ...
};
```

The service is unavailable unless both `ROBLOX_API_KEY` and
`ROBLOX_UNIVERSE_ID` are set, and the `ROBLOX` action only validates when both are
present.

### Environment variables

| Variable                 | Required | Default        | Description                          |
| ------------------------ | -------- | -------------- | ------------------------------------ |
| `ROBLOX_API_KEY`         | Yes      | —              | Roblox Open Cloud API key            |
| `ROBLOX_UNIVERSE_ID`     | Yes      | —              | Universe ID of the experience        |
| `ROBLOX_PLACE_ID`        | No       | —              | Specific place ID                    |
| `ROBLOX_WEBHOOK_SECRET`  | No       | —              | Secret exposed in config for external inbound bridges |
| `ROBLOX_MESSAGING_TOPIC` | No       | `eliza-agent`  | Messaging Service topic              |
| `ROBLOX_DRY_RUN`         | No       | `false`        | `"true"` suppresses publish calls    |

## Plugin surface

- **Action `ROBLOX`** — routes three subactions:
  - `message` — publish text to the messaging topic, optionally to specific player IDs (max 25)
  - `execute` — publish a named game-side action (`move_npc`, `give_coins`, `teleport`, `spawn_entity`, `start_event`, …) with parameters; regex patterns infer common actions from natural language
  - `get_player` — look up a Roblox user by numeric ID or username (display name, ban status, creation date, avatar headshot)
- **Provider `roblox-game-state`** — injects connection state and experience metadata (universe/place ID, experience name, active players, visits, creator, messaging topic, dry-run flag) into agent context.
- **Service `RobloxService`** — singleton holding one `RobloxAgentManager` (and `RobloxClient`) per agent UUID.

### Direct service use

```typescript
import { RobloxService } from "@elizaos/plugin-roblox";

const service = runtime.getService<RobloxService>(RobloxService.serviceType);

await service.sendMessage(runtime.agentId, "Hello from your agent!");

await service.executeAction(
  runtime.agentId,
  "spawn_entity",
  { entityType: "dragon", location: "arena" },
  [12345678], // target specific players (optional)
);
```

## Receiving payloads in Roblox

The agent publishes JSON to `ROBLOX_MESSAGING_TOPIC`. Subscribe in a Roblox
server script to react:

```lua
local MessagingService = game:GetService("MessagingService")
local HttpService = game:GetService("HttpService")

local TOPIC = "eliza-agent" -- must match ROBLOX_MESSAGING_TOPIC

MessagingService:SubscribeAsync(TOPIC, function(message)
    local data = HttpService:JSONDecode(message.Data)
    if data.type == "agent_message" then
        print("Agent says:", data.content)
    elseif data.type == "agent_action" then
        print("Agent action:", data.action, data.parameters)
    end
end)
```

## Limitations

- **Inbound is not supported by Open Cloud.** There is no external subscribe API for
  `MessagingService`, so the plugin cannot poll player chat. To send Roblox → agent,
  run an HTTP bridge that the experience calls via `HttpService:RequestAsync(...)`.
- **Movement / world changes** happen only if your experience subscribes to the topic
  and interprets `agent_action` payloads (`move_npc`, `teleport`, …) using Roblox APIs.
- **No agent voice channel.** Open Cloud has none; audio playback requires game-side
  logic and Roblox asset constraints.

## Layout

```
plugin-roblox/
  index.ts            Plugin entry (robloxPlugin, RobloxService, RobloxClient, RobloxApiError)
  actions/            ROBLOX action router
  providers/          roblox-game-state provider
  services/           RobloxService (singleton)
  client/             RobloxClient (Open Cloud + roblox.com HTTP wrapper)
  types/              Shared type definitions
  utils/              config.ts (hasRobloxEnabled, validateRobloxConfig)
  prompts/            Prompt fragments (evaluators, providers)
  __tests__/          Vitest suite
```

## Commands

```bash
bun run build       # compile (build.ts)
bun run test        # vitest run __tests__/
bun run typecheck   # tsgo --noEmit
bun run lint        # biome check + fix
```

See `CLAUDE.md` for agent-facing internals and extension points.
