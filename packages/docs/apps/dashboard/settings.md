---
title: "Dashboard Settings"
sidebarTitle: "Dashboard Settings"
description: "Configure the Eliza web dashboard preferences, theme, permissions, and advanced runtime options."
---

The Dashboard Settings panel controls appearance, AI model selection, media generation, voice, permissions, updates, and agent data management. Settings are persisted to `localStorage` under the key `eliza.control.settings.v1`. On native platforms (iOS/Android) they are automatically synced to Capacitor Preferences, so they survive app reinstalls. Changes take effect immediately without restarting the agent.

Open the settings panel from the gear icon in the dashboard header or via the Command Palette (`Cmd/Ctrl+K`).

---

## 1. Appearance

Controls the visual theme applied across the entire dashboard UI. The active theme is stored separately in `localStorage` under the key `eliza:theme`.

| Theme | Description |
|---|---|
| `eliza` | Default. Clean black-and-white aesthetic. |
| `qt314` | Soft pastels. |
| `web2000` | Early-internet retro styling. |
| `programmer` | VSCode-dark color scheme. |
| `haxor` | Terminal green on black. |
| `psycho` | High-contrast chaos palette. |

```typescript
// Read the active theme
const theme = localStorage.getItem("eliza:theme"); // e.g. "eliza"

// Apply a theme programmatically
localStorage.setItem("eliza:theme", "programmer");
// The dashboard reads this on mount and applies the matching CSS class.
```

Switching themes in the UI writes `eliza:theme` and re-applies the stylesheet immediately — no reload required.

---

## 2. AI Model

Selects the AI provider and model used for agent inference. The available providers are configured dynamically per plugin and may include:

- **Eliza Cloud** (default managed option)
- **OpenAI**
- **Anthropic**
- Additional providers registered by installed plugins

Each plugin can expose its own provider switcher, so the options shown here reflect the plugins currently active for the selected agent. Changes apply to new messages immediately; in-flight requests complete against the previously selected model.

---

## 3. Wallet / RPC / Secrets

Embeds the `ConfigPageView` component, which exposes wallet configuration including:

- RPC endpoint selection per supported chain
- Connected wallet addresses
- Secret management (API keys, private environment variables)

Private keys stored here are **not** displayed in plaintext within this section. To retrieve them, use **Export Keys** in the [Danger Zone](#10-danger-zone).

---

## 4. Media Generation

Controls which providers handle image, video, audio, and vision tasks. Each sub-section has an independent provider selection and, for cloud-capable providers, a mode toggle between Eliza Cloud (no key required) and your own API key.

### Image

| Field | Options |
|---|---|
| Provider | `cloud`, `fal`, `openai`, `google`, `xai` |
| Mode | `cloud` (managed), `own-key` (enter your API key) |

### Video

| Field | Options |
|---|---|
| Provider | `cloud`, `fal`, `openai`, `google` |

### Audio / Music

| Field | Options |
|---|---|
| Provider | `cloud`, `suno`, `elevenlabs` |

### Vision

| Field | Options |
|---|---|
| Provider | `cloud`, `openai`, `google`, `anthropic`, `xai` |

When mode is `own-key`, an API key field appears below the provider selector. Keys are stored under `eliza.control.settings.v1` and are included in agent exports (encrypted).

---

## 5. Speech (TTS / STT)

Configures text-to-speech output and speech-to-text input for Talk Mode.

| Field | Options / Notes |
|---|---|
| Voice provider | `elevenlabs` (default), `edge`, `robot-voice` |
| Mode | `cloud` (managed), `own-key` |
| ElevenLabs API key | Required when mode is `own-key` |
| Model ID | Default: `eleven_flash_v2_5` |
| Voice preset | See table below |

### ElevenLabs Voice Presets

11 presets are available. Select one from the voice picker; the preset ID is sent with every TTS request.

| Preset name |
|---|
| Rachel |
| Sarah |
| Matilda |
| Lily |
| Brian |
| Adam |
| Josh |
| Daniel |
| Gigi |
| Mimi |
| Charlotte |

Custom voice IDs (from your ElevenLabs account) can be entered manually when the provider is set to `elevenlabs` with `own-key` mode.

---

## 6. Permissions & Capabilities

Displays and manages both OS-level system permissions and soft capability toggles that the agent can request at runtime.

### System Permissions (OS-managed)

These permissions are granted or denied by the operating system. The dashboard reflects the current permission state reported by the native Permissions module. To change them, follow the OS prompt or navigate to your system settings.

| Permission | Notes |
|---|---|
| Accessibility | Required for computer-use tasks on desktop. |
| Screen recording | Required for screen capture / vision on desktop. |
| Microphone | Required for Talk Mode STT. |
| Camera | Required for camera-based vision tasks. |

### Soft Capability Toggles

These toggles gate whether the agent is allowed to use a capability, independent of whether the OS permission has been granted.

| Toggle | Default | Description |
|---|---|---|
| Shell access | Off | Allow the agent to execute shell commands. |
| Browser control | Off | Allow the agent to control a browser via automation. |
| Computer use | Off | Allow the agent to control the mouse and keyboard. |
| Vision | Off | Allow the agent to capture and analyze screen content. |

Disabling a soft toggle takes effect immediately for new agent turns. Existing tool calls in flight complete normally.

---

## 7. Software Updates

| Field | Description |
|---|---|
| Current version | Displays the installed app version string. |
| Release channel | `stable` (default), `beta`, `nightly` |
| Update availability | Indicates whether a newer release is available on the selected channel. |
| Last checked | Timestamp of the most recent update check. |

Changing the release channel triggers an immediate check against that channel's update feed. Nightly builds may contain unstable features and are not recommended for production agent deployments.

---

## 8. Chrome Extension

Displays the status of the browser relay used for browser-control tasks.

| Field | Description |
|---|---|
| Relay server | WebSocket endpoint the extension connects to. Format: `ws://127.0.0.1:{port}/extension` |
| Connection status | Live indicator — connected or disconnected. |
| Extension path | Filesystem path to the unpacked extension (desktop only). |

The port is assigned dynamically at agent startup. If the extension shows disconnected, reload the extension from `chrome://extensions` and confirm the relay server is running.

---

## 9. Agent Export / Import

Allows you to back up and restore a complete agent snapshot.

### Export

Produces a `.eliza-agent` file. The export is encrypted with a password you provide and includes:

- Character definition
- Memory store
- Chat history
- Secrets and API keys
- Relationship graph

```
Settings > Agent Export / Import > Export Agent
→ Enter password
→ Download my-agent.eliza-agent
```

### Import

Accepts a `.eliza-agent` file created by a Eliza-compatible agent runtime. You must provide the password used at export time.

```
Settings > Agent Export / Import > Import Agent
→ Select .eliza-agent file
→ Enter password
→ Confirm overwrite (replaces current agent data)
```

Importing overwrites the current agent's character, memories, chats, secrets, and relationships. The operation cannot be undone without a separate export taken beforehand.

---

## 10. Danger Zone

Irreversible or security-sensitive operations.

| Action | Description |
|---|---|
| Export private keys | Reveals EVM and Solana private keys in plaintext. Requires confirmation. |
| Reset agent | Wipes all agent data: character, memories, chats, secrets, relationships. |

Private key export does not require a password beyond the confirmation dialog. Store exported keys offline immediately and do not leave the dialog open unattended.

**Reset agent** removes all data associated with the current agent from both `localStorage` and native Preferences. The action is not reversible without a prior [Agent Export](#9-agent-export--import).

---

## Storage Reference

| Storage key | Scope | Contents |
|---|---|---|
| `eliza.control.settings.v1` | `localStorage` + Capacitor Preferences | All settings described in this page except the active theme |
| `eliza:theme` | `localStorage` only | Active theme name string |

```typescript
// Read all settings
const raw = localStorage.getItem("eliza.control.settings.v1");
const settings = raw ? JSON.parse(raw) : {};

// Write a single field without overwriting others
const updated = { ...settings, speechProvider: "edge" };
localStorage.setItem("eliza.control.settings.v1", JSON.stringify(updated));
```

On iOS and Android the dashboard's storage bridge mirrors every write to Capacitor Preferences automatically. No additional configuration is required.

---

## Related

- [Web Dashboard](/apps/dashboard) — dashboard layout and navigation overview
- [Desktop App](/apps/desktop) — global keyboard shortcuts and native permission management
- [Mobile App](/apps/mobile) — storage bridge that syncs settings to Capacitor Preferences on iOS/Android
- [Talk Mode](/apps/dashboard/talk-mode) — voice conversation setup and Talk Mode configuration
- [Plugins](/plugins/overview) — how plugins register additional AI providers and capability toggles
