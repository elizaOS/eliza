---
title: "Self-Update API"
sidebarTitle: "Update"
description: "REST API endpoints for checking for updates and switching release channels."
---

The update API lets you check for new Eliza versions and switch between release channels (stable, beta, nightly). It reports the current version, installation method, available updates across all channels, and the local authority that is allowed to apply the update.

<Warning>
The REST API is status-only for updates. It does not expose a remote endpoint that runs package-manager, OS package-manager, or Git commands on the host.
</Warning>

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/update/status` | Check for updates and get version info |
| PUT | `/api/update/channel` | Switch the release channel |

---

### GET /api/update/status

Returns the current version, whether an update is available, and the latest version for each release channel. Pass `?force=true` to bypass the cache and check the registry directly.

**Query Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `force` | boolean | Force a fresh check (bypasses cache) |

**Response**

```json
{
  "currentVersion": "0.8.2",
  "channel": "stable",
  "installMethod": "npm-global",
  "updateAuthority": "package-manager",
  "nextAction": "run-package-manager-command",
  "canAutoUpdate": true,
  "canExecuteUpdate": false,
  "remoteDisplay": true,
  "updateCommand": "npm install -g elizaos@latest",
  "updateInstructions": "This is a remote status view. Run \"npm install -g elizaos@latest\" on the host; no remote execution endpoint is exposed.",
  "updateAvailable": true,
  "latestVersion": "0.9.0",
  "channels": {
    "stable": "0.9.0",
    "beta": "0.10.0-beta.3",
    "nightly": "0.10.0-nightly.20250601"
  },
  "distTags": {
    "stable": "latest",
    "beta": "beta",
    "nightly": "nightly"
  },
  "lastCheckAt": "2025-06-01T12:00:00.000Z",
  "error": null
}
```

| Field | Type | Description |
|-------|------|-------------|
| `currentVersion` | string | Currently running version |
| `channel` | string | Active release channel (`stable`, `beta`, or `nightly`) |
| `installMethod` | string | How Eliza was installed (`npm-global`, `bun-global`, `homebrew`, `apt`, `snap`, `flatpak`, `local-dev`, or `unknown`) |
| `updateAuthority` | string | Who owns update execution (`package-manager`, `os-package-manager`, `developer`, or `operator`) |
| `nextAction` | string | Recommended local action (`run-package-manager-command`, `run-git-pull`, `review-installation`, or `none`) |
| `canAutoUpdate` | boolean | Whether the local CLI updater has a command path for this install method |
| `canExecuteUpdate` | boolean | Whether this request context may execute the update. Remote status views return `false` because no remote execution endpoint exists. |
| `remoteDisplay` | boolean | `true` when the request is a remote display of host status rather than a trusted local request |
| `updateCommand` | string\|null | Human-readable command to run on the host, or `git pull` for local development checkouts |
| `updateInstructions` | string | Human-readable next-step guidance |
| `updateAvailable` | boolean | Whether a newer version exists for the current channel |
| `latestVersion` | string\|null | Latest version available for the current channel |
| `channels` | object | Latest version for each channel |
| `distTags` | object | npm dist-tag mapping for each channel |
| `lastCheckAt` | string\|null | ISO timestamp of the last update check |
| `error` | string\|null | Error message if the check failed |

---

### PUT /api/update/channel

Switch the active release channel. Clears the cached check so the next status request will fetch fresh data.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `channel` | string | Yes | `stable`, `beta`, or `nightly` |

```json
{
  "channel": "beta"
}
```

**Response**

```json
{
  "channel": "beta"
}
```

**Errors**

| Status | Condition |
|--------|-----------|
| 400 | Invalid channel value |
