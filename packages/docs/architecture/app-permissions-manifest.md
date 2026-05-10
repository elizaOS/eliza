# App permissions manifest

## Status

**Draft.** Phase 1 defines the permissions schema, parser, grant store, and Settings consent surface. Phase 2 adds worker hosting and gated runtime capabilities for apps that run with `isolation: "worker"`. Phase 3 tightens the loader policy so external apps are forced to `isolation: "worker"` even when their manifest omits isolation or declares `"none"`.

## Scope

This spec defines the declarative app manifest fields carried by elizaOS apps in their `package.json` under `elizaos.app.permissions` and `elizaos.app.isolation`. It applies to apps loaded via `APP load_from_directory` and to the `POST /api/apps/load_from_directory` HTTP route — i.e. every code path today that parses `package.json → elizaos.app` for third-party-app discovery.

It does **not** apply to elizaOS *plugins* (different surface, different enforcement story) or to first-party apps under `eliza/apps/` (auto-trusted by their source path; see "Trust tier", below).

## Goals

- Give third-party apps a declarative way to state what privileged surfaces they need.
- Make the declaration the durable contract that future enforcement layers (consent UI, worker isolation, FS gating, network gating) read.
- Persist the declared permissions alongside the registered app so a user can later inspect what was declared at register time.
- Persist the requested execution isolation so Phase 2 worker hosting can decide how to run the app without re-reading package.json.
- Forward-compatible: third-party app authors can declare permission namespaces that newer Milady versions will recognise; older Milady versions ignore unknown namespaces without rejecting the manifest.

## Non-goals

- Enforcement of any declared permission. The manifest and grants are advisory until Phase 2 worker execution reads them.
- Detailed consent UI / granted-store semantics. Those live in [`app-permissions-granted-store.md`](./app-permissions-granted-store.md).
- Trust tiering of first-party apps (out of scope; trust is encoded at the loader, not in the manifest).
- A schema for elizaOS plugins (`@elizaos/plugin-*`). Plugins are runtime extensions, not sandboxed UI surfaces; if a permission story for plugins is needed, it gets its own spec.

## Manifest location

The manifest fields live inside the existing `elizaos.app` block in the app's `package.json`:

```json
{
  "name": "@example/app-foo",
  "elizaos": {
    "app": {
      "displayName": "Foo",
      "category": "utility",
      "isolation": "worker",
      "permissions": {
        "fs": {
          "read":  ["state/**", "config.json"],
          "write": ["state/**"]
        },
        "net": {
          "outbound": ["api.example.com", "*.example.com"]
        }
      }
    }
  }
}
```

Putting the fields inside `elizaos.app` keeps every existing `discoverApps()` reader unchanged at the JSON-path level — the fields are simply available to callers that ask for them.

## Permission namespaces

This slice commits to **two** namespaces. Other namespace keys are reserved for future slices and are preserved verbatim by the parser (see "Forward compatibility").

### `fs` — filesystem access

```ts
type FsPermissions = {
  read?:  string[];   // glob patterns, root-relative within the app's state path
  write?: string[];   // same
};
```

- Patterns are POSIX-style globs interpreted against the app's *state path* (the path the loader assigns the app for sandboxed FS; today not strictly assigned — Phase 2 wires this).
- An empty array means "no FS access of this kind." Absence of the key means "no FS access of this kind."
- A single-element array `["**"]` means "unrestricted within the state path." It does **not** grant access outside the state path; that is structurally impossible regardless of declaration.
- Globs are not regex. `?`, `*`, `**`, and `{a,b}` are supported; everything else is literal.

### `net` — outbound network

```ts
type NetPermissions = {
  outbound?: string[];   // host patterns
};
```

- `outbound` is a list of host patterns. URLs (with scheme/path) are not accepted; this is a host-level allowlist.
- A bare hostname (`api.example.com`) matches that exact host.
- A leading `*.` (`*.example.com`) matches any subdomain of `example.com` and does **not** match the apex. To match both, declare both: `["example.com", "*.example.com"]`.
- A single `*` matches all hosts. Authors should prefer narrow allowlists; consent UIs in later slices will treat `["*"]` as a high-risk declaration.

## Trust tier (NOT in manifest)

Trust is a property of *how the app was loaded*, not something the app declares about itself. The loader computes a `trust` value at register time:

| Source | `trust` |
|---|---|
| `eliza/apps/<name>` (first-party, in-tree) | `"first-party"` |
| `APP load_from_directory <path>` and `POST /api/apps/load_from_directory` | `"external"` |
| Future: signed bundle with verified publisher | `"signed"` |

Apps cannot lie about their trust by editing their `package.json`. The loader's classification is authoritative.

The Phase 1 grant flow:
- Auto-grant first-party apps every permission they declare (no consent prompt).
- Require explicit user consent for external apps (per-namespace, persisted to a granted-permission store).

In this phase the loader records `trust`, `isolation`, and `requestedPermissions` in the audit log, but enforces nothing.

## Execution isolation

Apps may declare an optional `elizaos.app.isolation` field:

```ts
type AppIsolation = "none" | "worker";
```

- Omitted or `"none"` means a first-party app runs in-process. External apps cannot opt into this fast path; the loader promotes them to `"worker"` at register time and when reading persisted legacy registry entries.
- `"worker"` means the app is requesting the worker execution path. The worker host passes the app's declared permissions and current grants into the worker, and the worker's `runtime.fetch` / `runtime.fs` bridge gates network and state-directory access against that data.
- Unknown values are treated as `"none"` by this Milady version. This keeps older clients forward-compatible with future isolation modes while avoiding accidental enforcement claims for modes they do not understand.

## Forward compatibility

The parser MUST:

- Accept a manifest that declares only namespaces it does not recognise (preserve them verbatim under `raw`).
- Accept the absence of `permissions` entirely (treat as "no permissions declared").
- Reject (with a structured error) a manifest where a recognised namespace (`fs`, `net`) is present but malformed (wrong shape).
- Reject (with a structured error) a manifest where `permissions` is present but is not a JSON object.

The parser MUST NOT:

- Reject a manifest because of an unrecognised namespace key inside `permissions`.
- Reject a manifest because of an unrecognised key inside a recognised namespace (e.g. `fs.someFutureField`). The recognised slices are validated; the rest is preserved.

This rule means a third-party app that ships `permissions: { fs: {...}, capabilities: {...} }` keeps working when `capabilities` becomes a real namespace later, and keeps working today even though Milady ignores it.

## Persistence

### Per-app registry (`~/.<namespace>/app-registry.json`)

`AppRegistryEntry` gains:

- `requestedPermissions?: Record<string, unknown>` — raw declared permissions, absent for apps without a `permissions` block.
- `isolation?: "none" | "worker"` — effective execution isolation after loader policy is applied. Missing isolation defaults to `"none"` only for first-party entries; external entries are promoted to `"worker"` when registered and when legacy entries are read from disk.

Both fields are persisted alongside the existing `slug` / `canonicalName` / `aliases` / `directory` / `displayName` fields. Older entries written before these fields landed parse cleanly; absent `requestedPermissions` means no permissions were declared, and absent `isolation` defaults to `"none"`.

The persisted shape is the **raw** declared object, not the typed slice. This preserves forward compatibility through restarts: when a future Milady version recognises `capabilities`, it re-reads the same registry and the field is already there.

### Audit log (`~/.<namespace>/audit/app-loads.jsonl`)

Each register call appends a JSON line. The app-load audit line includes:

- `trust`: `"first-party" | "external"` (string)
- `isolation`: `"none" | "worker"` (string)
- `requestedPermissions`: the raw declared object, or `null` if the manifest declared no `permissions` block

Existing fields (`timestamp`, `directory`, `appName`, `slug`, `displayName`, `registeredByEntity`, `registeredByRoom`) are unchanged.

## Validation rules

A manifest validation produces one of:

1. **Empty** — no `permissions` block declared. Parser yields `{ raw: null, fs: undefined, net: undefined }`; `isolation` defaults to `"none"`.
2. **Valid** — `permissions` declared and every recognised namespace is well-formed. Parser yields `{ raw, fs?, net? }` where `fs` / `net` are present iff the corresponding namespace was declared.
3. **Invalid** — `permissions` declared but malformed. Parser yields a structured error: `{ ok: false, reason: string, path: string }`. The loader rejects the app and emits a single audit-log line of `kind: "rejected-manifest"`.

`isolation` is parsed independently from `permissions`: `"worker"` is accepted, while absent / `"none"` / unknown values resolve to `"none"` before loader policy is applied. The registry then forces external apps to `"worker"`.

Specific invalid shapes:

- `permissions` is not an object → `reason: "permissions must be an object"`.
- `permissions.fs.read` / `permissions.fs.write` exists and is not a `string[]` → `reason: "fs.<key> must be an array of glob strings"`.
- `permissions.net.outbound` exists and is not a `string[]` → `reason: "net.outbound must be an array of host pattern strings"`.
- Glob / host strings that exceed 256 characters → `reason: "<field>[<i>] exceeds 256 characters"` (length cap to keep the audit log tractable).

## Examples

### Minimal — no permissions declared

```json
{
  "elizaos": { "app": { "displayName": "Foo" } }
}
```

Parser: `{ raw: null, fs: undefined, net: undefined }`. App registers with `requestedPermissions: null` in the audit log.

### Read-only state, single API host

```json
{
  "elizaos": {
    "app": {
      "displayName": "Foo",
      "permissions": {
        "fs":  { "read":  ["state/**"] },
        "net": { "outbound": ["api.foo.com"] }
      }
    }
  }
}
```

### Forward-compatible — declares a future namespace

```json
{
  "elizaos": {
    "app": {
      "permissions": {
        "fs": { "read": ["**"] },
        "capabilities": { "screen-recording": true }
      }
    }
  }
}
```

Parser: `{ raw: {fs: {read: ["**"]}, capabilities: {...}}, fs: {read: ["**"]}, net: undefined }`. The `capabilities` slice is preserved in `raw` and will surface to a future Milady version that recognises it.

### Invalid — wrong shape on recognised namespace

```json
{
  "elizaos": {
    "app": {
      "permissions": {
        "fs": { "read": "state/**" }
      }
    }
  }
}
```

Parser rejects: `{ ok: false, reason: "fs.read must be an array of glob strings", path: "permissions.fs.read" }`. The app does not register; an audit-log line records the rejection.

### Worker isolation requested

```json
{
  "elizaos": {
    "app": {
      "displayName": "Foo",
      "isolation": "worker",
      "permissions": {
        "fs": { "read": ["state/**"] }
      }
    }
  }
}
```

The app registers with `isolation: "worker"` in `app-registry.json`, `app-loads.jsonl`, and `AppPermissionsView`. Runtime enforcement still waits for later Phase 2 slices.

## Phase mapping

| Slice | What lands |
|---|---|
| Phase 1, slice 1 | This spec; parser + types; wired into both `app-load-from-directory.ts` and `apps-routes.ts` discovery; audit log gets `trust` + `requestedPermissions`; `AppRegistryEntry` persists `requestedPermissions`. No enforcement. |
| Phase 1, slice 2 | Granted-permission store on disk; consent surface in Settings → Apps. |
| Phase 2.1 | `elizaos.app.isolation` parser + registry/audit/API persistence; no worker spawning or enforcement yet. |
| Phase 2.2 | `AppWorkerHostService` + Bun worker RPC bridge for apps that declare `isolation: "worker"`; no app-code loading or FS/net gating yet. |
| Phase 2 | Opt-in `isolation: "worker"` execution path; FS/state-path containment and outbound network gating using declared permissions plus user grants. |
| Phase 3 | External apps are forced to `isolation: "worker"` at register time and when legacy persisted entries are read. |
| Phase 3 | Default `isolation: "worker"` for `trust: "external"`; first-party stays in-process. |

## Cross-references

- `eliza/packages/shared/src/contracts/app-permissions.ts` — parser implementation and shared contract types.
- `eliza/plugins/plugin-app-control/src/actions/app-load-from-directory.ts` — registers external apps via the `APP` action.
- `eliza/packages/agent/src/api/apps-routes.ts` — registers external apps via the HTTP API (`POST /api/apps/load_from_directory`).
- `eliza/plugins/plugin-app-control/src/services/app-registry-service.ts` — persists registry + writes audit log.
- `eliza/plugins/plugin-app-control/src/protected-apps.ts` — separate concern: namespace-collision protection for first-party app slugs. Unaffected by this spec.
