# @elizaos/plugin-remote-manifest

Shared library providing the manifest schema, permission model, install store, wire protocol
types, artifact signature verification, and RPC MAC helpers for remote-mode elizaOS plugins.

## What it is

Remote plugins in elizaOS run in isolated Bun workers (or separate processes) and communicate
with the host over a typed message protocol. This package defines every stable contract in that
system:

- **`plugin.json` manifest schema** — validated by `validateRemotePluginManifest`.
- **Permission model** — `host:*` (windows, tray, notifications, storage, manage-remote-plugins)
  and `bun:*` (read, write, env, run, ffi, addons, worker) permission tags, plus isolation mode
  (`shared-worker` | `isolated-process`).
- **Install store** — synchronous CRUD for the on-disk registry (`registry.json` + per-plugin
  `install.json`), install/uninstall, bootstrap file generation.
- **Wire protocol** — discriminated union `RemotePluginWorkerMessage` covering init, RPC, host
  actions, host requests, streaming, and the unified plugin-announce messages.
- **Artifact signature verification** (SOC2 A-1) — SHA-256 + Ed25519 over plugin tarballs before
  installation.
- **RPC MAC** (SOC2 A-4) — HMAC-SHA256 over `WorkerRpcMessage` fields to prevent worker→host
  spoofing.

## Installation

This package is a private workspace dependency. Reference it via `workspace:*` in your
`package.json`:

```json
"@elizaos/plugin-remote-manifest": "workspace:*"
```

## Usage

```ts
import { validateRemotePluginManifest } from "@elizaos/plugin-remote-manifest/validation";
import { installPrebuiltRemotePlugin } from "@elizaos/plugin-remote-manifest/store";
import { verifyPluginArtifact } from "@elizaos/plugin-remote-manifest/signature";
import type { RemotePluginManifest, RemotePluginWorkerMessage } from "@elizaos/plugin-remote-manifest/types";
```

### Validate a manifest

```ts
const result = validateRemotePluginManifest(JSON.parse(manifestJson));
if (!result.ok) {
  for (const issue of result.issues) {
    console.error(`${issue.path}: ${issue.message}`);
  }
}
```

### Verify a plugin artifact before installing

```ts
// SOC2 A-1: always verify before calling installPrebuiltRemotePlugin
await verifyPluginArtifact({
  pluginId: "com.example.myplugin",
  version: "1.0.0",
  tarballPath: "/tmp/myplugin.tgz",
  signature: { hash: "...", signature: "..." },
  kms,
  auditDispatcher,
});
```

### Install a plugin

```ts
const installed = installPrebuiltRemotePlugin(storeRoot, payloadDir, {
  permissionsGranted: { host: { notifications: true }, bun: { read: true } },
  source: { kind: "artifact", location: downloadUrl },
});
```

## plugin.json schema

Every remote plugin must ship a `plugin.json` in its root:

```json
{
  "id": "com.example.myplugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "Does something useful.",
  "mode": "background",
  "permissions": {
    "host": { "notifications": true },
    "bun": { "read": true, "env": true },
    "isolation": "shared-worker"
  },
  "view": {
    "relativePath": "view/index.html",
    "title": "My Plugin",
    "width": 800,
    "height": 600
  },
  "worker": {
    "relativePath": "worker.mjs"
  }
}
```

- `id` — alphanumeric + `_-` segments joined by `.` (e.g. `com.example.foo`).
- `mode` — `window` (has a visible native window) or `background` (headless).
- `isolation` — `shared-worker` (default, lower overhead) or `isolated-process` (full sandbox).

## Sign a plugin tarball (operator tooling)

```bash
bun run packages/plugin-remote-manifest/scripts/sign-manifest.ts \
  --tarball ./my-plugin-1.2.3.tgz \
  --signer ops@example.com \
  --out ./my-plugin-1.2.3.tgz.sig.json
```

Reads `ELIZA_KMS_BACKEND` (`memory | local | steward`, default `local`). Emits a JSON sidecar
`{ "hash": "<hex>", "signature": "<base64>", "signer": "<label>" }`.

## See also

- `examples/hello-remote-plugin/` — minimal background-mode reference plugin.
- `examples/remote-plugin-clock/` — window-mode clock example.
- `packages/app-core/platforms/electrobun/src/native/remote-plugin-host.ts` — host-side runtime.
- `packages/agent/src/services/remote-plugin-bridge.ts` — agent-side bridge.
