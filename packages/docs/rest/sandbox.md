---
title: "Sandbox API"
sidebarTitle: "Sandbox"
description: "REST API endpoints for the agent sandbox — container management, screen capture, audio, computer use, and transaction signing."
---

The sandbox API exposes a containerized execution environment for the agent. It supports shell command execution, browser automation via CDP, screen capture, audio recording/playback, and mouse/keyboard control. The sandbox manager uses Docker or Apple Container (macOS) depending on the platform.

## Core Sandbox

### GET /api/sandbox/platform

Get platform information including Docker availability. This endpoint works without a running sandbox manager.

**Response**

```json
{
  "platform": "darwin",
  "arch": "arm64",
  "dockerInstalled": true,
  "dockerRunning": true,
  "dockerAvailable": true,
  "appleContainerAvailable": false,
  "wsl2": false,
  "recommended": "docker"
}
```

---

### GET /api/sandbox/status

Get the sandbox manager status.

**Response**

```json
{
  "running": true,
  "containerId": "abc123def456",
  "startedAt": 1718000000000,
  "cdpEndpoint": "http://localhost:9222",
  "wsEndpoint": "ws://localhost:9222/json"
}
```

---

### GET /api/sandbox/events

Get the sandbox event log (last 100 events).

**Response**

```json
{
  "events": [
    {
      "type": "container_started",
      "timestamp": 1718000000000,
      "message": "Sandbox container started"
    }
  ]
}
```

---

### GET /api/sandbox/capabilities

Detect available sandbox capabilities based on the current platform and installed tools.

**Response**

```json
{
  "screenshot": { "available": true, "tool": "screencapture (built-in)" },
  "audioRecord": { "available": true, "tool": "sox rec" },
  "audioPlay": { "available": true, "tool": "afplay (built-in)" },
  "computerUse": { "available": true, "tool": "cliclick" },
  "windowList": { "available": true, "tool": "AppleScript" },
  "browser": { "available": true, "tool": "CDP via sandbox browser container" },
  "shell": { "available": true, "tool": "docker exec" }
}
```

---

### POST /api/sandbox/start

Start the sandbox container.

**Response**

Returns the sandbox status object (same shape as `GET /api/sandbox/status`).

---

### POST /api/sandbox/stop

Stop the sandbox container.

**Response**

Returns the sandbox status object.

---

### POST /api/sandbox/recover

Attempt to recover a failed sandbox.

**Response**

Returns the sandbox status object.

---

### POST /api/sandbox/docker/start

Attempt to start Docker Desktop (works on macOS and Windows).

**Response**

```json
{
  "success": true,
  "message": "Docker Desktop is starting on macOS. Give it a moment~",
  "waitMs": 15000
}
```

---

### POST /api/sandbox/exec

Execute a shell command inside the sandbox container.

**Request**

```json
{
  "command": "ls -la /workspace",
  "workdir": "/workspace",
  "timeoutMs": 30000
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | Shell command to execute |
| `workdir` | string | No | Working directory inside the container |
| `timeoutMs` | integer | No | Execution timeout in milliseconds |

**Response (200 on exit code 0, 422 on non-zero)**

```json
{
  "exitCode": 0,
  "stdout": "total 24\ndrwxr-xr-x ...",
  "stderr": ""
}
```

---

### GET /api/sandbox/browser

Get browser CDP and WebSocket endpoints for automation.

**Response**

```json
{
  "cdpEndpoint": "http://localhost:9222",
  "wsEndpoint": "ws://localhost:9222/json"
}
```

---

## Screen

### GET /api/sandbox/screen/screenshot

Capture a screenshot of the current screen. Returns a PNG image directly.

**Response**

`Content-Type: image/png` — raw PNG binary.

---

### POST /api/sandbox/screen/screenshot

Capture a screenshot and return it as base64-encoded JSON. Optionally capture a specific screen region.

**Request** (optional)

```json
{
  "x": 0,
  "y": 0,
  "width": 1920,
  "height": 1080
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `x` | integer | No | Region left edge in pixels |
| `y` | integer | No | Region top edge in pixels |
| `width` | integer | No | Region width in pixels (must be > 0) |
| `height` | integer | No | Region height in pixels (must be > 0) |

**Response**

```json
{
  "format": "png",
  "encoding": "base64",
  "width": null,
  "height": null,
  "data": "iVBORw0KGgoAAAANSUhEUgAA..."
}
```

---

### GET /api/sandbox/screen/windows

List visible windows on the desktop.

**Response**

```json
{
  "windows": [
    {
      "id": "12345",
      "title": "Terminal",
      "app": "Terminal"
    }
  ]
}
```

---

## Audio

### POST /api/sandbox/audio/record

Record audio from the system microphone and return it as base64-encoded WAV.

**Request**

```json
{
  "durationMs": 5000
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `durationMs` | integer | No | Recording duration in milliseconds (default: 5000, min: 250, max: 30000) |

**Response**

```json
{
  "format": "wav",
  "encoding": "base64",
  "durationMs": 5000,
  "data": "UklGRiQ..."
}
```

---

### POST /api/sandbox/audio/play

Play audio from base64-encoded data.

**Request**

```json
{
  "data": "UklGRiQ...",
  "format": "wav"
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | string | Yes | Base64-encoded audio data |
| `format` | string | No | Audio format: `wav`, `mp3`, `ogg`, `flac`, or `m4a` (default: `wav`) |

**Response**

```json
{
  "success": true
}
```

---

## Computer Use

### POST /api/sandbox/computer/click

Perform a mouse click at the specified screen coordinates.

**Request**

```json
{
  "x": 960,
  "y": 540,
  "button": "left"
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `x` | integer | Yes | X coordinate in pixels |
| `y` | integer | Yes | Y coordinate in pixels |
| `button` | string | No | `"left"` or `"right"` (default: `"left"`) |

**Response**

```json
{
  "success": true,
  "x": 960,
  "y": 540,
  "button": "left"
}
```

---

### POST /api/sandbox/computer/type

Type text via keyboard input. Maximum 4096 characters.

**Request**

```json
{
  "text": "Hello, World!"
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | string | Yes | Text to type (max 4096 characters) |

**Response**

```json
{
  "success": true,
  "length": 13
}
```

---

### POST /api/sandbox/computer/keypress

Send a key press or key combination. Allowed characters: letters, numbers, space, `+`, `_`, `.`, `,`, `:`, `-`. Maximum 128 characters.

**Request**

```json
{
  "keys": "return"
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `keys` | string | Yes | Key name or combination (e.g., `"return"`, `"escape"`, `"ctrl+c"`) |

**Response**

```json
{
  "success": true,
  "keys": "return"
}
```

---

## Signing

### POST /api/sandbox/sign

Submit a transaction signing request for agent review and approval.

**Request**

```json
{
  "requestId": "req-001",
  "chainId": 1,
  "to": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  "value": "1000000000000000000",
  "data": "0x",
  "createdAt": 1718000000000
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `requestId` | string | Yes | Unique request identifier |
| `chainId` | integer | Yes | EVM chain ID (>= 0) |
| `to` | string | Yes | Recipient address (0x followed by 40 hex characters) |
| `value` | string | Yes | Value in wei as a decimal string |
| `data` | string | Yes | Transaction calldata as hex string |
| `nonce` | integer | No | Transaction nonce |
| `gasLimit` | string | No | Gas limit as a decimal string |
| `createdAt` | integer | Yes | Request creation timestamp (Unix ms) |

**Response**

```json
{
  "success": true,
  "signature": "0x..."
}
```

---

### POST /api/sandbox/sign/approve

Approve a pending signing request.

**Request**

```json
{
  "requestId": "req-001"
}
```

**Response**

```json
{
  "success": true
}
```

---

### POST /api/sandbox/sign/reject

Reject a pending signing request.

**Request**

```json
{
  "requestId": "req-001"
}
```

**Response**

```json
{
  "rejected": true
}
```

---

### GET /api/sandbox/sign/pending

List all pending signing approvals.

**Response**

```json
{
  "pending": [
    {
      "requestId": "req-001",
      "chainId": 1,
      "to": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      "value": "1000000000000000000",
      "createdAt": 1718000000000
    }
  ]
}
```

---

### GET /api/sandbox/sign/address

Get the signer's Ethereum address.

**Response**

```json
{
  "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
}
```

## Common Error Codes

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_REQUEST` | Request body is malformed or missing required fields |
| 401 | `UNAUTHORIZED` | Missing or invalid authentication token |
| 404 | `NOT_FOUND` | Requested resource does not exist |
| 503 | `DOCKER_UNAVAILABLE` | Docker daemon is not running or not available |
| 422 | `EXECUTION_FAILED` | Command execution failed with non-zero exit code |
| 504 | `TIMEOUT` | Sandbox execution exceeded the timeout limit |
| 500 | `INTERNAL_ERROR` | Unexpected server error |
