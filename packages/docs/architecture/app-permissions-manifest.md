# App permissions manifest

## Status

**Draft.** Phase 1, slice 1 — schema + parser only, no enforcement, no consent UI, no granted-permission store. Subsequent slices add consent persistence, then worker-isolation enforcement, then default-tightening.

## Scope

This spec defines the declarative permission manifest carried by elizaOS apps in their `package.json` under `elizaos.app.permissions`. It applies to apps loaded via `APP load_from_directory` and to the `POST /api/apps/load_from_directory` HTTP route — i.e. every code path today that parses `package.json → elizaos.app` for third-party-app discovery.

It does **not** apply to elizaOS *plugins* (different surface, different enforcement story) or to first-party apps under `eliza/apps/` (auto-trusted by their source path; see "Trust tier", below).

## Goals

- Give third-party apps a declarative way to state what privileged surfaces they need.
- Make the declaration the durable contract that future enforcement layers (consent UI, worker isolation, FS gating, network gating) read.
- Persist the declared permissions alongside the registered app so a user can later inspect what was declared at register time.
- Forward-compatible: third-party app authors can declare permission namespaces that newer Milady versions will recognise; older Milady versions ignore unknown namespaces without rejecting the manifest.

## Non-goals (this slice)

- Enforcement of any declared permission. The manifest is *advisory* in this slice.
- A consent UI or granted-permission store on disk.
- Trust tiering of first-party apps (out of scope; trust is encoded at the loader, not in the manifest).
- A schema for elizaOS plugins (`@elizaos/plugin-*`). Plugins are runtime extensions, not sandboxed UI surfaces; if a permission story for plugins is needed, it gets its own spec.

## Manifest location

The manifest is a `permissions` object inside the existing `elizaos.app` block in the app's `package.json`:

```json
{
  "name": "@example/app-foo",
  "elizaos": {
    "app": {
      "displayName": "Foo",
      "category": "utility",
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

Putting the block inside `elizaos.app` keeps every existing `discoverApps()` reader unchanged at the JSON-path level — the field is simply available to callers that ask for it.

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

In a later slice the consent flow will:
- Auto-grant first-party apps every permission they declare (no consent prompt).
- Require explicit user consent for external apps (per-namespace, persisted to a granted-permission store).

In *this* slice the loader records `trust` and `requestedPermissions` in the audit log, but enforces nothing.

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

`AppRegistryEntry` gains an optional `requestedPermissions: Record<string, unknown>` field, persisted alongside the existing `slug` / `canonicalName` / `aliases` / `directory` / `displayName` fields. Older entries written before this slice landed parse cleanly; the field is simply absent.

The persisted shape is the **raw** declared object, not the typed slice. This preserves forward compatibility through restarts: when a future Milady version recognises `capabilities`, it re-reads the same registry and the field is already there.

### Audit log (`~/.<namespace>/audit/app-loads.jsonl`)

Each register call appends a JSON line. This slice adds two fields:

- `trust`: `"first-party" | "external"` (string)
- `requestedPermissions`: the raw declared object, or `null` if the manifest declared no `permissions` block

Existing fields (`timestamp`, `directory`, `appName`, `slug`, `displayName`, `registeredByEntity`, `registeredByRoom`) are unchanged.

## Validation rules

A manifest validation produces one of:

1. **Empty** — no `permissions` block declared. Parser yields `{ raw: null, fs: undefined, net: undefined }`.
2. **Valid** — `permissions` declared and every recognised namespace is well-formed. Parser yields `{ raw, fs?, net? }` where `fs` / `net` are present iff the corresponding namespace was declared.
3. **Invalid** — `permissions` declared but malformed. Parser yields a structured error: `{ ok: false, reason: string, path: string }`. The loader rejects the app and emits a single audit-log line of `kind: "rejected-manifest"`.

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

## Phase mapping

| Slice | What lands |
|---|---|
| **Phase 1, slice 1** (this slice) | This spec; parser + types; wired into both `app-load-from-directory.ts` and `apps-routes.ts` discovery; audit log gets `trust` + `requestedPermissions`; `AppRegistryEntry` persists `requestedPermissions`. No enforcement. |
| Phase 1, slice 2 | Granted-permission store on disk; consent surface in Settings → Apps; per-app statePath assignment. |
| Phase 2 | Opt-in `isolation: "worker"` execution path; FS gating using declared `fs` globs; outbound network gating using declared `net.outbound`. |
| Phase 3 | Default `isolation: "worker"` for `trust: "external"`; first-party stays in-process. |

## Cross-references

- `eliza/plugins/plugin-app-control/src/permissions.ts` — parser implementation (this slice).
- `eliza/plugins/plugin-app-control/src/actions/app-load-from-directory.ts` — registers external apps via the `APP` action.
- `eliza/packages/agent/src/api/apps-routes.ts` — registers external apps via the HTTP API (`POST /api/apps/load_from_directory`).
- `eliza/plugins/plugin-app-control/src/services/app-registry-service.ts` — persists registry + writes audit log.
- `eliza/plugins/plugin-app-control/src/protected-apps.ts` — separate concern: namespace-collision protection for first-party app slugs. Unaffected by this spec.
