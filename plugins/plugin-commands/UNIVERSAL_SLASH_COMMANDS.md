# Universal slash commands

One command catalog, every surface. A user types `/settings model` in the
floating chat, a Discord channel, a Telegram DM, or the terminal UI, and the
same command runs — discovered from one source, rendered natively per surface.

## Why one catalog

Before this, four disconnected slash systems existed: the web composer parsed
slashes only at send-time (no menu), the Cmd+K palette had its own nav
vocabulary, Discord had native application commands, Telegram had almost
nothing, and the TUI library had an unused autocomplete engine. Nothing shared
a definition. This system makes **`@elizaos/plugin-commands` the single
source of truth** and exposes it over HTTP so every surface consumes the same
list.

```
            @elizaos/plugin-commands  (per-runtime registry)
            DEFAULT_COMMANDS + NAVIGATION_COMMANDS + skill/custom commands
                                   │
                  serializeCommands(surface)  ── wire-safe, no functions
                                   │
        ┌──────────────────┬───────┴────────┬───────────────────┐
   GET /api/commands   getConnectorCommands  getConnectorCommands  GET /api/commands
     ?surface=gui         ("discord")          ("telegram")          ?surface=tui
        │                    │                     │                    │
   Web composer        Discord native        Telegram                 TUI Editor
   inline menu         app commands          setMyCommands +          autocomplete
   (SlashCommandMenu)  (application.commands) bot.command handlers    (CombinedAutocompleteProvider)
```

## The command model

A `CommandDefinition` (see `src/types.ts`) carries two dimensions beyond name +
description:

- **`surfaces?: CommandSurface[]`** — which client surfaces it appears on
  (`gui` · `tui` · `discord` · `telegram`). Absent = all four. e.g.
  `/fullscreen` is `["gui"]`; `/clear` and `/new` are `["gui", "tui"]`.
- **`target?: CommandTarget`** — what it *does*, surface-agnostically:
  - `{ kind: "navigate", tab?, viewId?, path?, section? }` — jump to a view /
    sub-view. GUI selects the tab/section, TUI navigates the view registry,
    chat connectors reply with a deep link.
  - `{ kind: "agent", action? }` — send the command text to the agent; an
    action/handler produces the reply. Works on every surface.
  - `{ kind: "client", clientAction }` — a pure-client behavior (clear chat,
    new conversation, toggle fullscreen). GUI/TUI only.

Arguments (`args[]`) can declare static `choices` or a `dynamicChoices` source
(`models` · `views` · `settings-sections` · `skills` · `providers`) that each
surface resolves against its own live data. `serializeCommand()` drops
function-valued choices so the catalog is always JSON-safe over the wire.

## The catalog

### Navigation (target: `navigate`) — `src/navigation-commands.ts`

| Command | Aliases | Destination |
|---|---|---|
| `/settings [section]` | `/preferences` `/config-ui` | settings tab; `section` arg jumps to a sub-view (model→`ai-model`, voice, connectors, security, secrets, …) |
| `/orchestrator` | `/workbench` `/agents` | orchestrator workbench view |
| `/views` | `/apps` | apps & views launcher |
| `/chat` | | chat surface |
| `/plugins` | | installed plugins |
| `/skills` | | skills library |
| `/wallet` | `/inventory` | wallet & inventory |
| `/knowledge` | `/documents` `/docs` | knowledge & documents |
| `/character` | `/persona` | character editor |
| `/automations` | `/triggers` `/heartbeats` | automations & heartbeats |
| `/tasks` | | tasks view |
| `/logs` | | logs view |
| `/database` | `/db` | database browser |

### Client (target: `client`) — gui/tui only

| Command | Aliases | Action |
|---|---|---|
| `/clear` | `/cls` | clear the current chat thread |
| `/new` | | start a new conversation |
| `/fullscreen` | `/expand` | toggle full-screen chat (gui only) |

### Agent capability (target: `agent`) — `src/registry.ts` `DEFAULT_COMMANDS`

`/help` `/commands` `/status` `/context` `/whoami` · `/stop` `/restart`
`/reset` `/compact` · `/think` `/verbose` `/reasoning` `/elevated` `/model`
`/models` `/usage` `/queue` · `/allowlist` `/approve` `/subagents` · `/tts` ·
plus `skill-<slug>` commands registered from loaded skills and any custom
actions the user has defined. These flow to the agent and reply in-channel.

### Design decisions — what is *not* a command

- **No natural-language similes** on command actions — the LLM would misroute
  "I need help" to `/help`. Commands are slash-only.
- `/voice` is deliberately **not** a navigation command; it's owned by `/tts`
  (toggle text-to-speech). Voice *settings* are reached via `/settings voice`.
- Connector navigation degrades gracefully: a Discord/Telegram user has no app
  view to jump to, so `navigate` commands reply with a destination + deep link
  rather than failing.
- `client` commands are filtered out of the connector surfaces entirely
  (`/fullscreen` makes no sense in Telegram).

## Per-surface rendering

### Web / desktop chat — the floating composer

`ContinuousChatOverlay` (the always-present ambient composer) gets an inline
autocomplete menu (`SlashCommandMenu` + `useSlashMenu`):

- Type `/` → dark-glass menu floats above the bar listing all `gui` commands.
- Type `/se` → fuzzy-ranked filter (alias prefix > native name > description).
- **Tab** completes the highlighted command (`/settings ` — drills into args).
- **Enter** runs the highlighted command. Arrow keys move; **Esc** dismisses
  (keeps the draft); click/`pointerdown` executes.
- `/settings ` shows the section choices (model · voice · connectors · …);
  `/settings model` → Enter navigates to the `ai-model` settings sub-view.
- Navigation runs client-side (`setTab` / `eliza:navigate:settings` /
  `eliza:navigate:view`); client commands run overlay/app effects; agent
  commands flow through the normal send pipeline (so `/model gpt-5` reaches the
  agent). Combobox a11y (`role=combobox`, `aria-expanded`,
  `aria-activedescendant`).

Catalog source: `GET /api/commands?surface=gui` (merged client-side with saved
custom commands + custom actions). See `packages/ui/src/chat/slash-menu.ts`
(pure logic, unit-tested) and `useSlashCommandController.ts`.

### Discord — native application commands

`plugins/plugin-discord` maps `getConnectorCommands("discord")` →
`DiscordSlashCommand[]` and registers them via the existing
`DISCORD_REGISTER_COMMANDS` → `client.application.commands.set(...)` path,
*alongside* the existing built-ins (built-ins win on name collisions, so the
role-gated `/help`/`/status`/`/model`/`/settings` keep their behavior). The
`section` arg becomes a string option with choices. On invocation: `agent`
commands route through the message pipeline and reply (deferReply→editReply);
`navigate` commands reply (ephemeral) with the destination + deep link.

### Telegram — `setMyCommands` + handlers

`plugins/plugin-telegram` calls `bot.telegram.setMyCommands(getTelegramBotCommands())`
after launch (so commands appear in Telegram's `/` menu) and registers
`bot.command(name, handler)` per catalog entry. `agent` commands force a reply
through the message pipeline even when `TELEGRAM_AUTO_REPLY` is off (an explicit
command is explicit intent); `navigate` commands reply with the destination +
optional deep link. Command names are sanitized to Telegram's `[a-z0-9_]{1,32}`.

### TUI — the Editor autocomplete

`packages/agent/src/tui` fetches `GET /api/commands?surface=tui`, maps to the
`@elizaos/tui` `SlashCommand[]`, and feeds the rich `Editor`'s
`CombinedAutocompleteProvider` (dropdown via `SelectList`, `/`-at-line-start
trigger, Tab/Enter completion, arg completions). On submit: `agent` → send to
agent; `navigate` (view) → `POST /api/views/:id/navigate?viewType=tui`;
`client` → local `/clear` / `/new`.

## Verification status

- **Web (gui):** live-verified — Storybook story + Playwright screenshots
  (desktop + mobile: all-commands / filtered / sections / filtered-section),
  22 pure-logic tests + 12 jsdom integration tests, all green.
- **plugin-commands:** 42 unit tests (catalog, surface filtering, serialization,
  settings-section resolution, connector mapping) + the route handler's 6 tests.
- **TUI:** live-verified — `packages/agent/scripts/verify-tui-slash.ts` drives
  the real `AgentTerminalView` + Editor against a booted agent (open menu / 36
  commands, filter, 39 section completions, dispatch — 4/4), and a real-PTY
  launch (`expect`) confirms the dropdown renders + filters in an actual
  terminal. That PTY run also surfaced + fixed a width-overflow crash on 80-col
  terminals (`render()` now truncates every line to width).
- **Discord / Telegram:** code-complete + unit-tested (mapping + dispatch
  branching). End-to-end requires live bot tokens, not available here —
  exercised at the unit level only.

## Adding a command

```ts
import { registerCommand } from "@elizaos/plugin-commands";

registerCommand({
  key: "my-view",
  nativeName: "myview",
  description: "Open my custom view",
  textAliases: ["/myview"],
  scope: "both",
  category: "navigation",
  surfaces: ["gui", "tui"],          // omit for everywhere
  target: { kind: "navigate", viewId: "my-view", path: "/my-view" },
});
```

It appears automatically in the web menu, the TUI autocomplete, and (if a
connector surface is listed) Discord/Telegram registration — no per-surface
wiring.
```
