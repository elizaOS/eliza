---
title: Streaming Integration
---

# Streaming Integration — Agent Skill Reference

Eliza agents can autonomously control live streaming: go live, switch channels, manage stream overlays, speak via TTS, and switch what content is being captured — all through built-in actions.

---

## Quick Start

To start a stream, call:
```
Action: GO_LIVE
```

To stop:
```
Action: GO_OFFLINE
```

---

## Available Actions

### GO_LIVE
Start broadcasting to the active destination.

**Similes:** START_STREAM, BEGIN_STREAM, START_BROADCASTING

**Example trigger phrases:**
- "Start the stream"
- "Go live now"
- "Begin broadcasting"

**Returns:** `"Stream is now live! 🔴"` on success.

---

### GO_OFFLINE
Stop the active stream.

**Similes:** STOP_STREAM, END_STREAM, END_BROADCAST

**Example trigger phrases:**
- "Stop the stream"
- "Go offline"
- "End the broadcast"

---

### SWITCH_STREAM_SOURCE
Change what content is being captured and streamed.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| sourceType | string | yes | `"stream-tab"`, `"game"`, or `"custom-url"` |
| customUrl | string | when `custom-url` | The URL to stream from |

**Source types:**
- `stream-tab` — captures the stream browser tab (default, shows agent activity)
- `game` — captures the active game iframe
- `custom-url` — captures an arbitrary HTTP(S) URL (e.g. OBS virtual camera output)

**Example:**
```
Action: SWITCH_STREAM_SOURCE
Parameters: { "sourceType": "custom-url", "customUrl": "https://camera.example.com/feed" }
```

---

### SET_STREAM_DESTINATION
Switch the active streaming channel. The stream **must be offline** before switching.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| destinationId | string | no* | Exact destination ID (from API) |
| destinationName | string | no* | Destination name (case-insensitive, e.g. "Twitch") |

*At least one of `destinationId` or `destinationName` is required.

**Example:**
```
Action: SET_STREAM_DESTINATION
Parameters: { "destinationName": "Twitch" }
```

**Configured destinations** use `@elizaos/plugin-streaming` with `streaming` config keys (`twitch`, `youtube`, `x`, `pumpfun`, `customRtmp`, `rtmpSources`, …)—see architecture docs.

**Workflow to switch channels:**
1. `GO_OFFLINE`
2. `SET_STREAM_DESTINATION` with new channel
3. `GO_LIVE`

---

### SPEAK_ON_STREAM
Speak text aloud via TTS during the stream.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| text | string | yes | The text to speak aloud |

**Example:**
```
Action: SPEAK_ON_STREAM
Parameters: { "text": "Welcome to the stream, everyone!" }
```

> Requires stream voice to be enabled in Stream Settings → Voice.

---

### MANAGE_OVERLAY_WIDGET
Enable or disable a stream overlay widget.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| widgetType | string | yes | Widget type (see list below) |
| action | string | yes | `"enable"` or `"disable"` |
| destinationId | string | no | Target a per-destination layout |

**Available widget types:**
| Widget | Description |
|--------|-------------|
| `viewer-count` | Live viewer count badge (top-left) |
| `alert-popup` | Pop-up cards for new viewers and chat |
| `action-ticker` | Horizontal ticker of agent actions |
| `thought-bubble` | Agent thought bubbles with animation |
| `branding` | Customizable logo/text overlay |
| `custom-html` | User-supplied HTML/CSS widget |
| `peon-hud` | Anime-style HUD overlay (default theme) |
| `peon-glass` | Frosted glass anime HUD |
| `peon-sakura` | Sakura-themed anime HUD |

**Example — enable viewer count:**
```
Action: MANAGE_OVERLAY_WIDGET
Parameters: { "widgetType": "viewer-count", "action": "enable" }
```

**Example — disable branding for a specific destination:**
```
Action: MANAGE_OVERLAY_WIDGET
Parameters: { "widgetType": "branding", "action": "disable", "destinationId": "twitch-main" }
```

---

## Stream Status

To check if the stream is running, use the HTTP API directly:

```
GET http://127.0.0.1:31337/api/stream/status
```

Response fields:
- `running` — whether FFmpeg pipeline is active
- `ffmpegAlive` — whether FFmpeg process is healthy
- `uptime` — seconds elapsed since stream started
- `frameCount` — frames captured so far
- `volume` — current audio volume (0–100)
- `muted` — whether audio is muted
- `audioSource` — name of audio capture device
- `destination` — `{ id, name }` of active destination

---

## Overlay Layout API

Layouts are per-destination and persist across restarts.

**Get layout:**
```
GET /api/stream/overlay-layout
GET /api/stream/overlay-layout?destination=<destinationId>
```

**Save layout:**
```
POST /api/stream/overlay-layout
POST /api/stream/overlay-layout?destination=<destinationId>
Body: { "layout": { "version": 1, "name": "My Layout", "widgets": [...] } }
```

**Widget instance schema:**
```json
{
  "id": "w1abc",
  "type": "viewer-count",
  "enabled": true,
  "position": { "x": 0, "y": 0, "width": 10, "height": 6 },
  "zIndex": 14,
  "config": {}
}
```

Position values are percentages of the 1280×720 capture canvas.

---

## Voice / TTS API

```
GET /api/stream/voice          — fetch TTS settings
POST /api/stream/voice         — save TTS settings
POST /api/stream/voice/speak   — speak text now ({ "text": "..." })
```

---

## Destination Management API

```
GET  /api/streaming/destinations        — list all configured destinations
POST /api/streaming/destination         — switch active destination ({ "destinationId": "..." })
```

---

## Autonomous Streaming Example

An agent that greets viewers, goes live, and reacts to chat:

```
1. User asks agent to "start streaming on Twitch"
→ Agent calls: SET_STREAM_DESTINATION { destinationName: "Twitch" }
→ Agent calls: GO_LIVE
→ Agent calls: SPEAK_ON_STREAM { text: "Hi everyone, stream is starting!" }
→ Agent calls: MANAGE_OVERLAY_WIDGET { widgetType: "viewer-count", action: "enable" }

2. Chat message comes in greeting the agent
→ Agent responds in chat
→ Agent optionally calls: SPEAK_ON_STREAM { text: "Thanks for watching!" }

3. User says "show my branding overlay"
→ Agent calls: MANAGE_OVERLAY_WIDGET { widgetType: "branding", action: "enable" }

4. User says "switch to YouTube and keep streaming"
→ Agent calls: GO_OFFLINE
→ Agent calls: SET_STREAM_DESTINATION { destinationName: "YouTube" }
→ Agent calls: GO_LIVE
→ Agent calls: SPEAK_ON_STREAM { text: "Now streaming on YouTube!" }
```

---

## Notes

- All streaming APIs are only available on `127.0.0.1` (localhost). Agents running as part of the Eliza server have direct access.
- Switching destinations requires the stream to be offline first.
- Overlay widget configs (position, zIndex, custom config fields) can only be set via the `/api/stream/overlay-layout` API directly; MANAGE_OVERLAY_WIDGET only toggles enabled/disabled.
- The stream view pop-out window (`?popout` URL param) is what gets captured by FFmpeg — do not close it while live.
