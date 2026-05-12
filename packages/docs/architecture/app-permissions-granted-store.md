# Granted-permissions store

## Status

**Draft.** Phase 1 — backend store, HTTP endpoints, first-party auto-grant, and the Settings → App Permissions panel. The grant state is advisory until Phase 2 enforcement reads it.

## Scope

This spec defines how *grants* — the user's decision to allow an app's declared permissions — are persisted and exposed via HTTP. Pairs with [`app-permissions-manifest.md`](./app-permissions-manifest.md): the manifest is what an app *declares*; the granted store is what the user has *approved*.

## Non-goals (this slice)

- Glob-level / host-level granular grants. Slice 2 grants at the **namespace** level only (`fs`, `net`). A user either grants the app's declared `fs` set or doesn't. Granular per-glob grants can land later if a real product need surfaces.
- Per-app `statePath` assignment. Mentioned in slice 1's phase map as "slice 2" but moved out — it pairs more naturally with Phase 2's `isolation: "worker"` execution path. This slice does not assign state paths.
- Enforcement. The granted set is **advisory** in this slice — no FS or network gating reads it yet. Phase 2 wires the enforcement.

## Granularity model

A grant is a **set of namespace names** that the user has approved for an app. Currently the recognised namespaces are `fs` and `net`. The granted set is a subset of the namespaces the app *declared* in its manifest.

```ts
type GrantedNamespaces = string[];   // e.g. ["fs"], ["fs", "net"], or []
```

Granting a namespace means: when Phase 2 enforcement lands, the app's declared rules within that namespace become live. So granting `"fs"` for an app whose manifest declares `fs.read: ["state/**"]` will (in Phase 2) allow reads matching `state/**` and deny everything else. The user is granting the manifest's declared scope, not granting unrestricted access.

This keeps the consent surface tractable (toggle per namespace) while preserving the manifest's granular intent.

### Trust tier behaviour

| `trust` | Default grant set on register | User can change? |
|---|---|---|
| `first-party` | All declared namespaces auto-granted | Yes (can revoke; default re-grants on next register) |
| `external` | Empty | Yes (must explicitly grant per namespace) |

First-party apps are auto-granted because the trust tier itself is the user's prior consent (the operator chose to ship the app in `eliza/apps/`). External apps require explicit user action — that is the entire point of this layer.

If an external app declares no `permissions` block at all (`requestedPermissions === null`), it has nothing to grant; the granted set is `[]` and stays empty.

## Persistence

Single flat file at `~/.<namespace>/granted-permissions.json`:

```json
{
  "version": 1,
  "grants": {
    "<app-slug>": {
      "namespaces": ["fs"],
      "grantedAt": "2026-05-10T14:30:00.000Z",
      "lastUpdatedAt": "2026-05-10T14:30:00.000Z"
    }
  }
}
```

- One file (not per-app) so the whole grant state can be read in a single FS call by the apps API.
- Atomic writes via `${file}.<pid>.<timestamp>.tmp` + `rename`, mirroring the existing `app-registry.json` pattern.
- Malformed file → reset to `{version: 1, grants: {}}` with a warning log; same recovery posture as `readPersisted` in `AppRegistryService`.
- Slug is the canonical key. App rename via `slug` change in `package.json` is a re-register and effectively a fresh grant cycle (no migration of grants across slugs in this slice).

## Audit log

`recordGrantChange()` appends a line to `~/.<namespace>/audit/app-permissions.jsonl` (separate file from `app-loads.jsonl`):

```json
{ "kind": "granted",   "timestamp": "...", "slug": "foo", "namespaces": ["fs", "net"], "actor": "user|first-party-auto" }
{ "kind": "revoked",   "timestamp": "...", "slug": "foo", "namespaces": ["net"],       "actor": "user" }
```

`actor` is `"first-party-auto"` when the auto-grant fires at register time, `"user"` when driven by an HTTP grant/revoke call.

## HTTP API

All routes live in `packages/agent/src/api/apps-routes.ts`.

### `GET /api/apps/permissions/:slug`

Returns the merged view of declared + granted state for one app:

```ts
type AppPermissionsView = {
  slug: string;
  trust: "first-party" | "external";
  isolation: "none" | "worker";
  requestedPermissions: Record<string, unknown> | null;   // raw from manifest
  recognisedNamespaces: string[];                          // ["fs", "net"] subset actually present
  grantedNamespaces: string[];                             // current grant set
  grantedAt: string | null;                                // ISO timestamp, null if never granted
};
```

`isolation` is the effective execution mode after loader policy is applied. First-party apps may remain `"none"` unless they request `"worker"`; external apps are promoted to `"worker"` even when older registry entries did not persist an isolation field.

`404` if no app is registered under `:slug`.

### `PUT /api/apps/permissions/:slug`

Replaces the granted-namespace set. Idempotent. Body:

```json
{ "namespaces": ["fs", "net"] }
```

Validation:
- Each namespace must appear in the app's `requestedPermissions` (the user cannot grant a namespace the app didn't ask for).
- Each namespace must be a recognised name (`"fs"` | `"net"`). Forward-compat: namespaces declared in the manifest but not yet recognised by this Eliza version are ignored — neither granted nor an error — so the user sees only namespaces this version can actually enforce.
- `404` if no app registered under `:slug`.
- `400` if the body is not `{namespaces: string[]}`.

Returns the same `AppPermissionsView` shape as `GET`, reflecting the post-update state.

### `GET /api/apps/permissions`

Returns `AppPermissionsView[]`, one permissions view per registered app. This lets the Settings → App Permissions panel render the whole grant surface with one fetch.

## Service surface

`AppRegistryService` gains:

```ts
class AppRegistryService extends Service {
  async getGrantedNamespaces(slug: string): Promise<string[]>;
  async setGrantedNamespaces(
    slug: string,
    namespaces: string[],
    actor: "user" | "first-party-auto",
  ): Promise<{ ok: true; view: AppPermissionsView } | { ok: false; reason: string }>;
  async getPermissionsView(slug: string): Promise<AppPermissionsView | null>;
  async listPermissionsViews(): Promise<AppPermissionsView[]>;
}
```

The HTTP endpoints in `apps-routes.ts` reach into the runtime via the existing `getService("app-registry")` cast and call these methods. No cross-package import; the structural type cast pattern that already exists in that file is extended.

`register()` is updated to call `setGrantedNamespaces(slug, declaredNamespaces, "first-party-auto")` when `ctx.trust === "first-party"`. External registers do not auto-grant.

## What `recognisedNamespaces` means

Phase 1 slice 1 commits to `["fs", "net"]`. The `parseAppPermissions` parser only surfaces those two as typed slices. `recognisedNamespaces` for an app is the intersection of:

1. The namespaces the app declared (`requestedPermissions` keys)
2. The namespaces Eliza currently recognises (`["fs", "net"]` today)

This is what the consent UI should render as toggleable rows. Forward-compat namespaces in the manifest (e.g. `capabilities`) appear in `requestedPermissions` (so a UI could surface them informationally) but not in `recognisedNamespaces` and cannot be granted.

## Cross-references

- `eliza/packages/docs/architecture/app-permissions-manifest.md` — slice 1 spec (manifest contract).
- `eliza/plugins/plugin-app-control/src/services/app-registry-service.ts` — owns the grant store.
- `eliza/packages/agent/src/api/apps-routes.ts` — the HTTP surface.
- `eliza/packages/shared/src/contracts/app-permissions.ts` — recognised-namespace check uses `parseAppPermissions` to compute the intersection.
