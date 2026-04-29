---
title: Avatar API
sidebarTitle: Avatar
description: REST API endpoints for uploading and serving custom VRM avatars.
---

## Upload Custom VRM Avatar

```
POST /api/avatar/vrm
```

Uploads a custom VRM avatar file and saves it to `~/.milady/avatars/custom.vrm`, replacing any previous upload.

**Request:** Raw binary body containing a `.vrm` (glTF-binary) file.

| Constraint | Value |
|------------|-------|
| Max file size | 50 MB |
| Format | glTF-binary (must begin with `glTF` magic bytes) |

**Response:**
```json
{ "ok": true, "size": 1048576 }
```

`size` is the file size in bytes.

**Errors:** `400` if body is empty, exceeds 50 MB, or fails the glTF magic-byte check.

## Get Custom VRM Avatar

```
GET /api/avatar/vrm
```

Serves the currently uploaded custom VRM avatar file. Also supports `HEAD` requests for existence checks.

**Response:** Binary VRM/GLB file body.

| Header | Value |
|--------|-------|
| `Content-Type` | `model/gltf-binary` |
| `Content-Length` | File size in bytes |
| `Cache-Control` | `no-cache` |

**Errors:** `404` if no custom avatar has been uploaded.
