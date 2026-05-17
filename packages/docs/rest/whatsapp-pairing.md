---
title: WhatsApp Pairing API
sidebarTitle: WhatsApp
description: REST API endpoints for WhatsApp QR-code pairing, connection status, and disconnection.
---

## Start Pairing

```
POST /api/whatsapp/pair
```

Initiates a WhatsApp QR-code pairing session. Replaces any existing session for the given account. Maximum 10 concurrent sessions.

**Request body:**
```json
{ "accountId": "default" }
```

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `accountId` | string | no | `"default"` |

`accountId` is sanitized — only alphanumeric characters, hyphens, and underscores are accepted.

**Response:**
```json
{ "ok": true, "accountId": "default", "status": "pending" }
```

**Errors:** `400` invalid `accountId`; `429` too many concurrent sessions; `500` session start failure.

## Connection Status

```
GET /api/whatsapp/status
```

Returns the current pairing status, whether auth credentials exist on disk, and whether the live WhatsApp service is connected.

**Query params:**

| Param | Type | Required | Default |
|-------|------|----------|---------|
| `accountId` | string | no | `"default"` |

**Response:**
```json
{
  "accountId": "default",
  "status": "idle",
  "authExists": true,
  "serviceConnected": false,
  "servicePhone": null
}
```

| Status | Meaning |
|--------|---------|
| `idle` | No pairing session active |
| `pending` | Pairing in progress, waiting for QR scan |
| `connected` | Successfully paired and connected |
| `error` | Pairing failed |

`servicePhone` is `null` when not connected.

## Stop Pairing

```
POST /api/whatsapp/pair/stop
```

Stops an in-progress pairing session without removing stored auth credentials.

**Request body:**
```json
{ "accountId": "default" }
```

**Response:**
```json
{ "ok": true, "accountId": "default", "status": "idle" }
```

Always returns `ok: true` even if no session was active.

## Disconnect

```
POST /api/whatsapp/disconnect
```

Stops any active pairing session, performs a Baileys logout, deletes auth files from disk, and removes the WhatsApp connector from the saved config.

**Request body:**
```json
{ "accountId": "default" }
```

**Response:**
```json
{ "ok": true, "accountId": "default" }
```

Logout and file-deletion failures are logged but suppressed — the response is always `ok: true` on success.
