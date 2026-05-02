---
title: Web Dashboard
sidebarTitle: Dashboard
description: Navigate the Eliza web dashboard to configure your agent, chat, manage knowledge, and access advanced settings.
---

The Eliza web dashboard is the primary interface for interacting with your agent. It provides a full-featured control panel for chatting, configuring your agent's character, managing plugins, and monitoring runtime behavior.

## Accessing the Dashboard

The dashboard runs as a web application served by the Eliza agent runtime.

| Method | Details |
|--------|---------|
| **Default URL** | `http://localhost:2138` |
| **CLI shortcut** | Run `eliza dashboard` to open the dashboard in your default browser |
| **Desktop app** | The Electrobun desktop app embeds the dashboard directly (no browser required) |

On first launch you will see the server chooser / startup flow. If the selected
server still needs setup, Eliza continues into onboarding for that server
before you reach the main dashboard. If authentication is required you will see
the **Pairing View** before reaching the main dashboard.

<Info>
The dashboard port defaults to `2138`. If this port is already in use, the runtime will log the actual port it binds to. Check the startup logs for the exact URL.
</Info>

## Dashboard Layout

The dashboard uses a tab-based navigation system. On the Chat tab, the layout includes a **Conversations Sidebar** on the left, the **Chat View** in the center, and an **Autonomous Panel** on the right. On mobile viewports (below 1024 px), the sidebar and autonomous panel collapse into overlay buttons.

A **Header** bar sits at the top of every page, and a **Terminal Panel** is available at the bottom. A **Command Palette** (Cmd/Ctrl+K in the desktop app) provides quick access to actions across the dashboard.

### Header Bar

The header displays across all tabs and includes:

- **Agent name** -- the name of the currently running agent, pulled from `agentStatus.agentName`.
- **Agent status indicator** -- a color-coded dot showing the agent's runtime state (see [Agent Status Indicator](#agent-status-indicator) below).
- **Wallet addresses** -- truncated EVM and Solana addresses with copy-to-clipboard functionality.
- **Cloud credits** -- if Eliza Cloud is enabled, the header shows credit balance with color-coded thresholds (green for OK, yellow for low, red for critical), along with a top-up link.
- **Lifecycle controls** -- Pause/Resume and Restart buttons for the agent runtime. These are disabled during state transitions (starting, restarting).
- **Drop / Mint status** -- when a public mint is active and the user has not yet minted, a mint button appears.

### Responsive Design

The dashboard adapts to viewport width:

| Viewport | Behavior |
|----------|----------|
| **Desktop** (1024 px and above) | Full three-column layout: sidebar, chat, autonomous panel |
| **Tablet** (768-1023 px) | Sidebar and autonomous panel collapse to overlay toggles |
| **Mobile** (below 768 px) | Single-column layout; sidebar and panel open as full-screen overlays |

The `ConversationsSidebar` and `AutonomousPanel` components both accept a `mobile` prop that switches their rendering mode and adds a close button.

## Tabs

The navigation is organized into primary tabs and an Advanced group:

| Tab Group | Tabs | URL Path |
|-----------|------|----------|
| **Chat** | chat | `/chat` |
| **Character** | character | `/character` |
| **Wallets** | wallets | `/wallets` |
| **Knowledge** | knowledge | `/knowledge` |
| **Social** | connectors | `/connectors` |
| **Apps** | apps | `/apps` |
| **Settings** | settings | `/settings` |
| **Advanced** | plugins, skills, actions, triggers, fine-tuning, trajectories, runtime, database, logs, security | Various |

Legacy paths are redirected automatically: `/game` maps to Apps, `/agent` to Character, `/inventory` to Wallets, `/features` to Plugins, `/admin` to Advanced, and `/config` to Settings.

### Chat

The default landing tab — a full messaging interface with voice chat, 3D avatar, conversation management, and autonomous monitoring.

<Card title="Chat Documentation" icon="message" href="/dashboard/chat">
  Full Chat tab documentation — message area, voice chat, VRM avatar, conversations sidebar, autonomous panel, emote picker, and context menu.
</Card>

### Character

Configure your agent through the Character hub. The view is organized into five sections:

1. **Overview** -- a high-level snapshot of the agent's current identity and character state.
2. **Personality** -- editable persona fields such as name, bio, system prompt, style, topics, adjectives, examples, and voice-shaping copy.
3. **Knowledge** -- uploaded documents and supporting reference material used for retrieval.
4. **Experience** -- surfaced learnings and experience signals gathered by the runtime.
5. **Relationships** -- people and relationship context associated with the agent.

Changes are saved via a save bar at the bottom of the view.

### Wallets

Displays wallet balances and NFTs. Shows token holdings across multiple EVM chains (Ethereum, Base, Arbitrum, Optimism, Polygon) and Solana. Each chain is identified with a color-coded icon.

### Knowledge

Manage your agent's knowledge base:

- **Stats display** -- document count and fragment count.
- **Document upload** -- file picker and drag-and-drop support.
- **URL upload** -- paste a URL; YouTube URLs are auto-transcribed.
- **Search** -- full-text search across the knowledge base.
- **Document list** -- browse documents with delete functionality.
- **Document detail** -- view individual documents and their fragments.

### Social (Connectors)

Configure chat and social connector plugins. This is a filtered view of the Plugins system showing only connector-type plugins (e.g., Discord, Twitter, Telegram).

### Apps

A single-surface app browser with optional full-screen game mode. Browse and launch apps that integrate with your agent, including embedded game viewers.

### Settings

Unified scrollable preferences panel implemented in the `SettingsView` component. The view is organized into the following sections:

#### 1. Appearance

Theme picker with 6 built-in themes displayed as a button grid (3 columns on mobile, 6 on desktop):

| Theme | Description |
|-------|-------------|
| **eliza** | Clean black & white |
| **qt3.14** | Soft pastels |
| **web2000** | Green hacker vibes |
| **programmer** | VS Code dark |
| **haxor** | Terminal green |
| **psycho** | Pure chaos |

The active theme is highlighted. Theme selection is persisted to local storage and applied immediately. See [Themes & Avatars](/guides/themes) for details.

#### 2. AI Model

Provider selection and model configuration via the `ProviderSwitcher` component. This section supports:

- **Eliza Cloud** -- if cloud is enabled, shows connection status, credit balance (with low/critical thresholds), and a login/disconnect flow.
- **Local/third-party providers** -- toggle AI provider plugins (e.g., Anthropic, OpenAI) and configure their API keys and model settings.
- **Plugin config save** -- each provider plugin's settings can be saved independently.

#### 3. Wallet / RPC / Secrets

Embedded configuration view (`ConfigPageView` with `embedded` prop) for managing wallet addresses, RPC endpoint URLs, and secret values (API keys, tokens). This is the same configuration system available through the Config page, rendered inline within Settings.

#### 4. Speech (TTS / STT)

The `VoiceConfigView` component configures:

- **Text-to-Speech provider** -- ElevenLabs or browser-native TTS.
- **Speech-to-Text** -- transcription provider configuration.
- **Voice preview** -- test the selected voice configuration.

#### 5. Permissions & Capabilities

The `PermissionsSection` component manages system permission grants for native platforms (Electrobun desktop app). Controls access to features like file system, microphone, camera, and notifications.

#### 6. Software Updates

- **Current version** display.
- **Release channel** selection via radio buttons: Stable (recommended), Beta (preview), or Nightly (bleeding edge).
- **Check Now** button for manual update checks.
- **Update available** banner showing current and latest version with instructions to run `eliza update`.
- **Last checked** timestamp.

#### 7. Chrome Extension

- **Relay server status** -- shows whether the WebSocket relay at `ws://127.0.0.1:{port}/extension` is reachable, with a green/red indicator.
- **Check Connection** button to re-test relay status.
- **Release status** -- links to the Browser Relay status page, which explains that the extension is not shipped in release `the current release` and must be sourced separately if needed.
- **Extension path** display when available.

#### 9. Agent Export / Import

- **Export** -- opens a modal that estimates export size (memories, entities, rooms, worlds, tasks), requires an encryption password (minimum 4 characters), and optionally includes logs. Downloads as a single encrypted file.
- **Import** -- opens a modal to select an `.eliza-agent` file and enter the decryption password used during export.

<Warning>
Exports contain all agent data including secrets and relationships. The encryption password protects the file -- choose a strong password and store it securely.
</Warning>

#### 10. Danger Zone

Visually separated section with red-bordered cards for irreversible actions:

- **Export Private Keys** -- reveals EVM and Solana private keys with copy buttons. Keys are hidden by default and toggled on demand.
- **Reset Agent** -- wipes all config, memory, and data, returning the application to the onboarding wizard. This action is irreversible.

<Warning>
Never share your private keys with anyone. Resetting the agent permanently deletes all data -- there is no undo.
</Warning>

### Advanced Group

The Advanced section contains specialized sub-tabs, each accessible via a secondary tab bar:

| Sub-tab | Path | Description |
|---------|------|-------------|
| **Plugins** | `/plugins` | Feature and connector plugin management. Searchable/filterable cards with per-plugin settings and a UI Field Showcase reference plugin. |
| **Skills** | `/skills` | Custom agent skills configuration. |
| **Actions** | `/actions` | Custom agent actions -- create and edit custom action definitions. |
| **Triggers** | `/triggers` | Scheduled and event-based automation management. |
| **Fine-Tuning** | `/fine-tuning` | Dataset and model training workflows. |
| **Trajectories** | `/trajectories` | LLM call history viewer and analysis. Includes a detail view for individual trajectories. |
| **Runtime** | `/runtime` | Deep runtime object introspection and load order inspection. |
| **Databases** | `/database` | Browse database tables, media files, and vector stores. |
| **Logs** | `/logs` | Runtime and service log viewer. |
| **Security** | `/security` | Sandbox and policy audit feed. |

## Agent Status Indicator

The dashboard displays a color-coded agent status indicator in the header. The state is derived from `agentStatus.state`:

| Color | States | Meaning |
|-------|--------|---------|
| **Green** (`text-ok`) | `running` | Agent is running normally |
| **Yellow** (`text-warn`) | `paused`, `starting`, `restarting` | Agent is in a transitional state |
| **Red** (`text-danger`) | `error` | Agent has encountered an error |
| **Gray** (`text-muted`) | `stopped`, unknown, not connected | Agent status is unknown or not connected |

## Plugin Management

Plugins are managed through the **Plugins** sub-tab under Advanced and the **Social** tab for connector-type plugins:

- **Search and filter** -- plugins are displayed as searchable, filterable cards.
- **Enable/disable** -- toggle individual plugins on or off. Changes may require an agent restart.
- **Per-plugin settings** -- each plugin can expose its own configuration UI, rendered via `ConfigRenderer`.
- **Plugin types** -- plugins are categorized as "feature" or "connector" types. The Social tab shows only connectors.

## Action Notices

Transient toast notifications appear at the bottom of the screen for action confirmations, errors, and informational messages, color-coded by tone (success, error, or neutral).

## Restart Banner

When the agent needs a restart (for example, after configuration changes), a banner appears prompting you to restart. The banner uses the lifecycle control system, which tracks `lifecycleBusy` and `lifecycleAction` to prevent conflicting operations.
