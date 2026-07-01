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
            DEFAULT_COMMANDS + navigationCommandDefinitions() + skill/custom commands
                                   │
              getCatalogCommands(surface) / getConnectorCommands(surface)
              each definition → serializeCommand()  ── wire-safe, no functions
                                   │
        ┌──────────────────┬───────┴────────┬───────────────────┐
   GET /api/commands   getConnectorCommands  getConnectorCommands  GET /api/commands
     ?surface=gui         ("discord")          ("telegram")          ?surface=tui
        │                    │                     │                    │
   Web composer        Discord native        Telegram                 TUI Editor
   inline menu         app commands          setMyCommands +          autocomplete
   (SlashCommandMenu)  (application.commands) bot.command handlers    (CombinedAutocompleteProvider)
```

`GET /api/commands` is a pure projection: the route
(`packages/agent/src/api/commands-routes.ts`) calls
`getCatalogCommands(surface, { activeViewId })` and serves the result. Every
field — `surfaces`, `requiresAuth`, `requiresElevated`, `category`,
`args[].dynamicChoices`, `target`, `icon`, `source` — comes from the
`CommandDefinition` via `serializeCommand()` (`src/serialize.ts`). Nothing is
fabricated at the HTTP boundary.

## The command model

A `CommandDefinition` (see `src/types.ts`) carries these dimensions beyond name +
description:

- **`surfaces?: CommandSurface[]`** — which client surfaces it appears on
  (`gui` · `tui` · `discord` · `telegram`). Absent = all four. e.g. `/clear`,
  `/fullscreen`, and `/transcribe` are `["gui", "tui"]`, so they are filtered
  off the chat connectors by surface.
- **`target?: CommandTarget`** — what it *does*, surface-agnostically. Absent =
  `{ kind: "agent" }`:
  - `{ kind: "navigate", path, tab?, viewId?, section? }` — jump to a view /
    sub-view. GUI selects the tab/section, TUI navigates the view registry,
    chat connectors reply with a deep link.
  - `{ kind: "agent", action? }` — send the command text to the agent; a
    deterministic `*_COMMAND` action produces the reply. Works on every surface.
  - `{ kind: "client", clientAction }` — a pure-client behavior (clear chat,
    toggle fullscreen, toggle transcription). GUI/TUI only.
- **`icon?: string`** — a lucide icon hint for menu rendering.
- **`views?: string[]`** — view-scoping (#8798): the command is surfaced only
  while one of these views is the active foreground surface. Omitted = global.

Arguments (`args[]`) can declare static `choices` or a `dynamicChoices` source
(a `CommandArgSource` — e.g. `views` · `settings-sections`) that each surface
resolves against its own live data. `serializeCommand()` (`src/serialize.ts`)
drops function-valued `choices` and carries `dynamicChoices` through so the
catalog is always JSON-safe over the wire. Navigation + client commands are
first-class `CommandDefinition`s in `src/navigation-commands.ts`
(`navigationCommandDefinitions()`); the catalog unions them with the agent
registry, so all three target kinds flow through one serializer.

## The catalog

### Navigation (target: `navigate`) — `src/navigation-commands.ts`

| Command | Destination |
|---|---|
| `/settings [section]` | settings tab; `section` arg (`dynamicChoices: settings-sections`) jumps to a sub-view (model→`ai-model`, voice, connectors, security, …) |
| `/chat` | chat surface |
| `/views [view]` | apps & views launcher; `view` arg `dynamicChoices: views` |
| `/orchestrator` | orchestrator workbench view |
| `/character` | character editor |
| `/knowledge` | knowledge & documents |
| `/wallet` | wallet & inventory |
| `/automations` | automations & heartbeats |
| `/tasks` | tasks view |
| `/skills` | skills library |
| `/plugins` | installed plugins |
| `/logs` | logs view |
| `/database` | database browser |

### Client (target: `client`) — `surfaces: ["gui", "tui"]`

| Command | Action |
|---|---|
| `/clear` | clear the current chat thread |
| `/fullscreen` | toggle full-screen chat |
| `/transcribe` | toggle long-form transcription mode |

### Agent capability (target: `agent`) — `src/registry.ts` `DEFAULT_COMMANDS`

`/help` `/commands` `/status` `/context` `/whoami` · `/stop` `/restart`
`/reset` `/new` `/compact` · `/think` `/verbose` `/reasoning` `/elevated`
`/model` `/models` `/usage` `/queue` · `/allowlist` `/approve` `/subagents` ·
`/tts` · `/bash` (and `/config` `/debug`, gated off by default) · plus
`skill-<slug>` commands registered from loaded skills and any custom actions the
user has defined. These flow to the agent and reply in-channel. Auth-gated
commands (`/restart` `/reset` `/compact` `/elevated` `/allowlist` `/approve`
`/subagents` `/bash` `/config` `/debug`) carry `requiresAuth: true`, which survives
serialization onto the wire.

### Design decisions — what is *not* a command

- **No natural-language similes** on command actions — the LLM would misroute
  "I need help" to `/help`. Commands are slash-only.
- `/voice` is deliberately **not** a navigation command; it's owned by `/tts`
  (toggle text-to-speech). Voice *settings* are reached via `/settings voice`.
- Connector navigation degrades gracefully: a Discord/Telegram user has no app
  view to jump to, so `navigate` commands reply with a destination + deep link
  rather than failing.
- `client` commands declare `surfaces: ["gui", "tui"]`, so they are filtered out
  of the connector surfaces entirely (`/fullscreen` makes no sense in Telegram).
- `/new` is an **agent** command (a new conversation is a runtime concern), not a
  client command — only `/clear`, `/fullscreen`, and `/transcribe` are `client`.

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
  `eliza:navigate:view`); client commands run overlay/app effects; deterministic
  agent commands (`/status`, `/model gpt-5`, `/think high`, `/reset`, …) resolve
  through registered `*_COMMAND` actions before inference; pipeline-owned agent
  commands still route through the normal send pipeline. Combobox a11y
  (`role=combobox`, `aria-expanded`, `aria-activedescendant`).

Catalog source: `GET /api/commands?surface=gui` (merged client-side with saved
custom commands + custom actions). See `packages/ui/src/chat/slash-menu.ts`
(pure logic, unit-tested) and `useSlashCommandController.ts`.

### Discord — native application commands

`plugins/plugin-discord` maps `getConnectorCommands("discord")` →
`DiscordSlashCommand[]` and registers them via the existing
`DISCORD_REGISTER_COMMANDS` → `client.application.commands.set(...)` path,
*alongside* the existing built-ins (built-ins win on name collisions, so the
role-gated `/help`/`/status`/`/model`/`/settings` keep their behavior). The
`section` arg becomes a string option with choices. On invocation: deterministic
`agent` commands answer locally through `resolveCommand`;
pipeline-owned `agent` commands route through the message pipeline and reply
(deferReply→editReply); `navigate` commands reply (ephemeral) with the
destination + deep link.

### Telegram — `setMyCommands` + handlers

`plugins/plugin-telegram` calls `bot.telegram.setMyCommands(getTelegramBotCommands())`
after launch (so commands appear in Telegram's `/` menu) and registers
`bot.command(name, handler)` per catalog entry. Deterministic `agent` commands
answer locally through `resolveCommand`; pipeline-owned `agent`
commands force a reply through the message pipeline even when
`TELEGRAM_AUTO_REPLY` is off (an explicit command is explicit intent);
`navigate` commands reply with the destination + optional deep link. Command
names are sanitized to Telegram's `[a-z0-9_]{1,32}`.

### TUI — the Editor autocomplete

`packages/agent/src/tui` fetches `GET /api/commands?surface=tui`, maps to the
`@elizaos/tui` `SlashCommand[]`, and feeds the rich `Editor`'s
`CombinedAutocompleteProvider` (dropdown via `SelectList`, `/`-at-line-start
trigger, Tab/Enter completion, arg completions). On submit: deterministic
`agent` commands resolve via registered actions, pipeline-owned `agent` commands
send to the agent; `navigate` (view) →
`POST /api/views/:id/navigate?viewType=tui`; `client` → local `/clear`,
`/fullscreen`, and `/transcribe`.

## Verification status

- **Web (gui):** live-verified — Storybook story + Playwright screenshots
  (desktop + mobile: all-commands / filtered / sections / filtered-section),
  22 pure-logic tests + 12 jsdom integration tests, all green.
- **plugin-commands:** 51 unit tests (catalog, surface + view filtering,
  serialization, settings-section resolution, connector mapping, navigation
  command defs, dispatch/handlers) + the route handler's 17 tests
  (`packages/agent/src/api/commands-routes.test.ts` drives `handleCommandsRoutes`
  with mocked `json`/`error`: surface filtering, auth pass-through, dynamic-choice
  emission; `commands-routes.real-server.test.ts` exercises the wire over a real
  loopback socket).
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
  category: "docks",
  surfaces: ["gui", "tui"],          // omit for everywhere
  target: { kind: "navigate", viewId: "my-view", path: "/my-view" },
});
```

It appears automatically in the web menu, the TUI autocomplete, and (if a
connector surface is listed) Discord/Telegram registration — no per-surface
wiring.
```
