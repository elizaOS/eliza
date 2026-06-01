# @elizaos/plugin-2004scape

An elizaOS plugin that adds an autonomous [2004scape](https://2004scape.org) (RuneScape 2004 revival) game agent to any Eliza agent.

## What it does

- Connects an Eliza agent to the 2004scape game via a local WebSocket gateway that bridges the in-browser game client to the elizaOS runtime.
- Runs an LLM-driven autonomous game loop on a configurable interval (default every 15 seconds). Each tick gathers live game context from four providers, builds a prompt, picks an action, and executes it.
- Exposes a single `RS_2004` action covering every in-game operation (movement, skills, inventory, banking, shopping, combat, NPC interaction).
- Provides an operator dashboard view (`TwoThousandFourScapeOperatorSurface`) that embeds the live game client and lets operators pause, resume, and steer the bot.

## Capabilities

### Action: `RS_2004`

One action covers all game operations. Pass `action` (the op name) and an optional `params` object.

| Op | Description |
|---|---|
| `walk_to` | Walk to named destination or `{x, z}` coordinates |
| `chop` | Chop a tree (`target` = tree name) |
| `mine` | Mine a rock (`target` = rock name) |
| `fish` | Fish a spot (`target` = spot name) |
| `burn` | Burn logs in inventory |
| `cook` | Cook raw food (`target` = food name) |
| `fletch` | Fletch logs |
| `craft` | Craft leather |
| `smith` | Smith at anvil (`target` = item name) |
| `drop` / `pickup` | Drop or pick up an item by name |
| `equip` / `unequip` | Equip or unequip an item by name |
| `use` | Use an item |
| `use_on_item` | Use one item on another |
| `use_on_object` | Use an item on a world object |
| `open` / `close` | Open/close bank (`target="bank"`) or shop (`target="shop"` or include `npc`) |
| `deposit` / `withdraw` | Bank operations; `count=-1` means all |
| `buy` / `sell` | Shop operations |
| `attack` | Attack an NPC by name |
| `cast_spell` | Cast a spell by ID, optional target NPC id |
| `set_style` | Set combat style (0–3) |
| `eat` | Eat food from inventory |
| `talk` | Talk to an NPC by name |
| `navigate_dialog` | Select a dialog option (1-based index) |
| `interact_object` | Interact with a world object |
| `open_door` | Open nearest door |
| `pickpocket` | Pickpocket an NPC |

### Context providers

| Provider | Provides |
|---|---|
| `RS_SDK_BOT_STATE` | Full live game state snapshot (player, skills, inventory, equipment, NPCs, messages, dialog, bank, shop) |
| `RS_SDK_MAP_AREA` | Current map zone, features, nearby NPCs, travel coordinates |
| `RS_SDK_WORLD_KNOWLEDGE` | Nearest bank, skill training recommendations by level, zone warnings |
| `RS_SDK_GOALS` | Prioritized goal list (IMMEDIATE / SHORT_TERM / MEDIUM_TERM / EXPLORE) derived from live state |

## Requirements

- **elizaOS** runtime with a registered 2004scape account.
- A reachable 2004scape server (default: `https://rs-sdk-demo.fly.dev`).
- Bun runtime (the embedded gateway uses `Bun.serve`).

## Configuration

Set these as agent character settings or environment variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `RS_SDK_BOT_NAME` | Yes* | auto-generated | Bot account username |
| `RS_SDK_BOT_PASSWORD` | Yes* | auto-generated | Bot account password |
| `RS_SDK_SERVER_URL` | No | `https://rs-sdk-demo.fly.dev` | Remote 2004scape server URL |
| `RS_SDK_GATEWAY_URL` | No | `ws://localhost:18791` | Gateway WebSocket URL |
| `RS_2004SCAPE_GATEWAY_PORT` | No | `18791` | Local gateway port |
| `RS_2004SCAPE_LOOP_INTERVAL_MS` | No | `15000` | Autonomous loop tick interval (ms) |
| `RS_2004SCAPE_MODEL_SIZE` | No | `TEXT_SMALL` | LLM size: `TEXT_NANO` / `TEXT_SMALL` / `TEXT_MEDIUM` / `TEXT_LARGE` |

*If `RS_SDK_BOT_NAME` is absent, the service starts but does not auto-connect. Credentials are auto-generated if missing and persisted to the agent's character settings.

Also accepted as legacy aliases: `BOT_NAME` (= `RS_SDK_BOT_NAME`) and `BOT_PASSWORD` (= `RS_SDK_BOT_PASSWORD`).

## Enabling the plugin

Add the plugin to your agent's character file or plugin list:

```json
{
  "plugins": ["@elizaos/plugin-2004scape"]
}
```

The plugin is opt-in and not loaded by default. All actions and providers require the agent to have `ADMIN` role.

## Operator dashboard

When the plugin is active, a `2004scape` tab appears in the elizaOS agent desktop. The tab embeds the live game client and provides:

- Live game session view
- Pause / resume autoplay controls
- Operator guidance input plus steering suggestions
- Current goal and intent display
- Recent activity log
