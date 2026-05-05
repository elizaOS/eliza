---
title: "Emotes API"
sidebarTitle: "Emotes"
description: "REST API endpoints for listing and triggering 3D emote animations on the agent avatar."
---

The emotes API lets you browse the catalog of available 3D emote animations and trigger them on the agent's avatar. Triggering an emote broadcasts a WebSocket event to all connected clients, which play the corresponding GLB animation.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/emotes` | List all available emotes |
| POST | `/api/emote` | Trigger an emote animation |

---

### GET /api/emotes

Returns the full emote catalog — all available 3D animations with their metadata.

**Response**

```json
{
  "emotes": [
    {
      "id": "wave",
      "label": "Wave",
      "glbPath": "/emotes/wave.glb",
      "duration": 2.0,
      "loop": false
    },
    {
      "id": "dance",
      "label": "Dance",
      "glbPath": "/emotes/dance.glb",
      "duration": 4.5,
      "loop": true
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `emotes[].id` | string | Unique emote identifier |
| `emotes[].label` | string | Display name |
| `emotes[].glbPath` | string | Path to the GLB animation file |
| `emotes[].duration` | number | Animation duration in seconds |
| `emotes[].loop` | boolean | Whether the animation loops |

---

### POST /api/emote

Trigger an emote animation. The server broadcasts a WebSocket message to all connected clients with the emote details.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `emoteId` | string | Yes | ID of the emote to trigger (from the catalog) |

```json
{
  "emoteId": "wave"
}
```

**Response**

```json
{
  "ok": true
}
```

**WebSocket Broadcast**

Connected clients receive:

```json
{
  "type": "emote",
  "emoteId": "wave",
  "glbPath": "/emotes/wave.glb",
  "duration": 2.0,
  "loop": false
}
```

**Errors**

| Status | Condition |
|--------|-----------|
| 400 | Unknown `emoteId` or no `emoteId` provided |
