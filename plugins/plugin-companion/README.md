# @elizaos/plugin-companion

Companion overlay plugin for elizaOS. Adds a 3D VRM avatar to an Eliza agent, with animated emotes, a chat overlay, and performance controls — rendered in a Three.js scene directly on the agent surface.

## What it does

- Renders a VRM (Virtual Reality Model) avatar in a 3D Three.js scene on the agent's companion surface.
- Enables the agent to play named emote animations via the `PLAY_EMOTE` action (wave, dance, cry, salute, and ~35 others).
- Provides three view surfaces: standard overlay, XR overlay, and a terminal (TUI) view.
- Bridges live agent state (chat messages, agent status, active coding sessions, triggers/heartbeats) into in-scene overlays rendered above the avatar.
- Ships a full emote catalog (`EMOTE_CATALOG`) of GLB and Mixamo FBX animations, all served as gzip-compressed assets.

## Capabilities added to the agent

### `PLAY_EMOTE` action

The agent can call this action to play a one-shot emote on the VRM avatar. It is silent — it does not generate chat text — and is intended to run alongside speech or reply actions.

Valid emote IDs (sample):

| ID | Description |
|----|-------------|
| `wave` | Waves both hands in greeting |
| `dance-happy` | Happy dance (loops) |
| `gangnam-style` | Gangnam style dance (loops) |
| `crying` | Cries sadly (loops) |
| `angry` | Expresses anger |
| `thinking` | Hand-to-chin thinking (loops) |
| `salute` | Sharp salute |
| `joyful-jump` | Jumps for joy |

Full catalog: `src/emotes/catalog.ts` — `AGENT_EMOTE_CATALOG` lists all IDs the agent can use.

## Required configuration

No env vars are required for basic use. Optional:

| Variable | Default | Description |
|----------|---------|-------------|
| `API_PORT` | `2138` | Port of the agent dashboard API server for emote delivery |
| `SERVER_PORT` | `2138` | Fallback if `API_PORT` is not set |

To disable emote playback for a specific character, set `character.settings.DISABLE_EMOTES` to any truthy value in the character configuration.

## How to enable

Add `@elizaos/plugin-companion` to the agent's plugin list. The plugin is session-gated — it only activates when the agent session is scoped to the companion app context.

```ts
import { appCompanionPlugin } from "@elizaos/plugin-companion";

// In your agent character/plugin config:
plugins: [appCompanionPlugin]
```

Alternatively, to register the companion as an overlay app (for hosts that use the overlay app registry):

```ts
import "@elizaos/plugin-companion/register"; // side-effect: calls registerCompanionApp()
// or explicitly:
import { registerCompanionApp } from "@elizaos/plugin-companion";
registerCompanionApp();
```

## Peer dependencies

Three.js, `@pixiv/three-vrm`, `react`, and `react-dom` must be installed by the host:

```bash
bun add three @pixiv/three-vrm react react-dom
```

## Build

```bash
bun run --cwd plugins/plugin-companion build        # full build (JS + views bundle + types)
bun run --cwd plugins/plugin-companion build:views  # Vite bundle for companion view components
bun run --cwd plugins/plugin-companion typecheck
bun run --cwd plugins/plugin-companion test
```
