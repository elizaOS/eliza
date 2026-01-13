## Roblox agent examples (elizaOS)

This folder shows how to run an **elizaOS agent** that can talk to a Roblox experience and trigger in-game behaviors.

### What `@elizaos/plugin-roblox` can do (today)

- **Outbound to Roblox (works)**: publish messages/actions into Roblox via **Roblox Open Cloud → MessagingService publish**.
  - Your Roblox servers subscribe to the topic and decide what to do with messages/actions.
- **Lookups (works)**: fetch **experience info** and **Roblox user info** via Roblox APIs.
- **DataStore (works)**: read/write Open Cloud DataStore entries (useful for configuration and low-rate state sync).

### What it cannot do by itself

- **Roblox → agent “subscribe”**: Roblox Open Cloud does not provide an external “subscribe to MessagingService” API.
  - That means the plugin cannot “listen to in-game chat” from outside Roblox by polling Open Cloud.
  - The TypeScript implementation currently has a `poll()` stub; there is no reliable Open Cloud endpoint to poll for player chat.

### How we bridge inbound chat/events

Use a **small HTTP bridge** that Roblox calls with `HttpService:PostAsync(...)`.

- Roblox → Agent: HTTP POST (chat/events)
- Agent → Roblox: Open Cloud MessagingService publish (via `@elizaos/plugin-roblox`)

### Can agents walk around / move place-to-place?

- **Within a place (yes, with a Roblox script)**: the agent can publish an `agent_action` like `move_npc` and your Roblox server script can move an NPC (`Humanoid:MoveTo` / pathfinding) or teleport players.
- **Across places (limited)**: cross-place teleport requires Roblox game logic (TeleportService) and the agent can only request it via an action; Roblox enforces experience/game rules.
- **“Agent walks around the world”** is not something Open Cloud does directly — it’s game-side code reacting to actions.

### Can agents chat?

Yes.
- Roblox → agent: forward player messages to the bridge endpoint.
- Agent → Roblox: publish agent replies to Roblox servers; Roblox decides how to display them (chat UI, billboards, NPC dialog, etc.).

### Can agents do voice?

Not directly via Open Cloud.
- The bridge can generate audio (e.g. via an external TTS provider), but **Roblox playback** requires your experience to handle audio delivery (assets or runtime audio constraints).
- In practice, most integrations start with **text chat** and add “voice-like” UI later (e.g. subtitles + local client TTS if your experience supports it).

### Examples

- **TypeScript**: `examples/roblox/typescript/` (canonical agent runtime + `@elizaos/plugin-roblox`)
- **Python**: `examples/roblox/python/` (canonical agent runtime + HTTP bridge)
- **Rust**: `examples/roblox/rust/` (canonical agent runtime + HTTP bridge)

### Roblox Studio scripts

See `examples/roblox/roblox-studio/` for a minimal server-side script that:
- subscribes to the MessagingService topic
- forwards player chat to the agent bridge
- executes example actions like `teleport` and `move_npc`

**Recommended defaults** (already enabled in the script):
- Only forward chat that **mentions the agent** (e.g. `eliza`, `@eliza`, `/eliza`) to avoid spamming your bridge.
- Basic per-player throttling to reduce rate limits/cost.

