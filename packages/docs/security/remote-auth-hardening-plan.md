# Eliza Remote Auth Hardening — Design Plan

Status: Draft for eliza-feature-coordinator handoff
Scope: P0 through P4, all approved
Audience: implementation specialists (api, electrobun, ui, plugin, ci)

## 0. Problem Statement

Today the API token is the only auth boundary, the cloud-provisioned bypass at `eliza/packages/app-core/src/api/server-onboarding-compat.ts:373` short-circuits onboarding without any token check, and tokens live in browser `localStorage` where any XSS gets durable cross-origin theft. There is no concept of an "owner identity" — the system has no way to answer "who is this user, and which connector account proves it?".

We need to replace this with a layered model: bootstrap secret to gate the container, multi-method primary auth, session cookies for the dashboard, and audit + rate limit on sensitive operations. Hardware fingerprint stays only as a free-tier provisioning convenience and is never trusted as a security boundary.

## 1. Auth Model — Data Structures

All persistent auth state lives in the eliza namespace under `~/.eliza/auth/` (respecting `ELIZA_STATE_DIR`). The DB (pglite) holds session and audit rows because we already have transactional writes there and because Bun + pglite is the project's blessed storage path. Files are reserved for material that must survive a DB rebuild (password hash, signing keys).

### 1.1 Identity

```ts
interface Identity {
  id: string;                  // uuid v7
  kind: "owner" | "machine";
  displayName: string;
  createdAt: number;
  // exactly one of these must be set; multiple bindings hang off OwnerBinding
  passwordHash?: string;       // argon2id encoded string
  cloudUserId?: string;        // Eliza Cloud user id when SSO-linked
}
```

Stored in `auth_identities` table; password hash mirrored to `~/.eliza/auth/password.json` (file-mode 0600) so a corrupted DB does not lock the user out forever.

### 1.2 OwnerBinding

```ts
interface OwnerBinding {
  identityId: string;
  connector: "discord" | "telegram" | "wechat" | "matrix";
  externalId: string;          // platform-native user id
  displayHandle: string;       // for UI
  verifiedAt: number;
  // pairing state — only populated during a pending bind
  pendingCode?: string;        // 6-digit numeric, hashed at rest
  pendingExpiresAt?: number;
}
```

Stored in `auth_owner_bindings`. Unique on `(connector, externalId)`. A single Identity can have several bindings.

### 1.3 Session

```ts
interface Session {
  id: string;                  // 256-bit random, hex; this is the cookie value
  identityId: string;
  kind: "browser" | "machine";
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;           // sliding for browser, absolute for machine
  rememberDevice: boolean;
  csrfSecret: string;          // used to derive CSRF tokens
  ip: string | null;
  userAgent: string | null;
  scopes: string[];            // empty for browser sessions = full; machine sessions list explicit scopes
  revokedAt?: number;
}
```

Stored in `auth_sessions`. TTLs:

- Browser session: 12h sliding, max 30 days when `rememberDevice=true`.
- Machine token: 90 days absolute, no sliding, must be rotated by user.
- Bootstrap session (cloud): 15 minutes from container boot, single-use, exchanged for a real session.

### 1.4 BootstrapToken (cloud only)

```ts
interface BootstrapTokenClaims {
  iss: "https://cloud.eliza.how";   // configurable via ELIZA_CLOUD_ISSUER
  sub: string;                       // cloud user id
  containerId: string;               // matches ELIZA_CLOUD_CONTAINER_ID
  scope: "bootstrap";
  iat: number;
  exp: number;                       // <= 24h from issuance
  jti: string;                       // for replay defence
}
```

Verified using a JWKS fetched from `${ELIZA_CLOUD_ISSUER}/.well-known/jwks.json` and cached on disk (`~/.eliza/auth/cloud-jwks.json`, refreshed every 6h). RS256 only.

### 1.5 AuditEvent

```ts
interface AuditEvent {
  id: string;
  ts: number;
  actorIdentityId: string | null;
  ip: string | null;
  userAgent: string | null;
  action: string;              // dotted, e.g. "auth.login.password.success"
  outcome: "success" | "failure";
  metadata: Record<string, string | number | boolean>;
}
```

Stored in `auth_audit_events` and mirrored as JSONL at `~/.eliza/auth/audit.log` (appended, rotated at 10MB) so a wiped DB does not lose history.

## 2. Connector-Owner Mechanism — Decision

Both DM-link and slash-command pairing should exist; **slash-command pairing is the canonical default**. Reasoning:

- DM-link requires the agent to be reachable and authenticated to the connector at the moment the user clicks. After a fresh container restart, the connector may not yet be online — the user is locked out by their own login method. That is the exact failure mode we are trying to fix in P0.
- Slash-command pairing flips the trust direction: the user types `/eliza-pair 482-193` from their phone, the connector handler matches it against a code shown in the dashboard, no outbound DM needed, works the moment the connector finishes its first poll.
- DM-link is offered as a "convenience login" once an owner binding already exists, reusing the same machinery as our existing pairing flow but scoped to a specific identity.

So: bind via slash-command, log in afterwards via DM-link by default with slash-command always available as the recovery path.

## 3. Cloud-Container Hardening (P0)

The unconditional skip in `server-onboarding-compat.ts:373` is replaced by mandatory bootstrap-token validation.

### 3.1 Provisioning

At deploy time the cloud control plane mints a `BootstrapTokenClaims` JWT signed with the cloud's RS256 key and injects it as `ELIZA_CLOUD_BOOTSTRAP_TOKEN`. The cloud dashboard exposes the same value with a "copy" affordance for the user, and a "rotate" button that invalidates the old `jti` server-side.

### 3.2 Verification path

A new module `eliza/packages/app-core/src/api/auth/bootstrap-token.ts` exposes:

```ts
export async function verifyBootstrapToken(
  token: string,
  env: RuntimeEnvRecord = process.env,
): Promise<BootstrapTokenClaims>;
```

It verifies signature against cached JWKS, checks `iss`, `exp`, `containerId === ELIZA_CLOUD_CONTAINER_ID`, and consults a local replay set (`auth_bootstrap_jti_seen`) to enforce single-use. A bootstrap token is exchanged exactly once for a real Session via `POST /api/auth/bootstrap/exchange`.

### 3.3 Rotation and revocation

- Rotation: cloud control plane mints a new token with a new `jti`; container picks it up on next restart or when the user re-pastes it in the dashboard. The old `jti` stays in the local replay set until natural expiry.
- Revocation: cloud control plane publishes a denied-`jti` list at `${ELIZA_CLOUD_ISSUER}/.well-known/revocations.json`, fetched on the same 6h cadence as JWKS. Containers that fail to refresh fall back to honouring `exp` only (documented degraded mode).

### 3.4 The bypass branch is removed

`isCloudProvisioned()` stays as a metadata helper but no longer authorises anything. The `/api/onboarding/status` early-return at `eliza/packages/app-core/src/api/auth-pairing-compat-routes.ts:124` and `/api/auth/status` at line 140 are deleted; both routes go through `ensureCompatApiAuthorized` like every other route, with an additional accept-bootstrap-token branch wired into a new `ensureAuthSessionOrBootstrap()` helper.

## 4. Session Model

### 4.1 Cookie shape

- Name: `eliza_session`. Attributes: `HttpOnly; Secure; SameSite=Lax; Path=/`. `Secure` is dropped only when bound on loopback (the Electrobun shell).
- Value: opaque session id (32 bytes hex). Server-side lookup; never JWT.

### 4.2 CSRF

Double-submit cookie pattern. Server emits `eliza_csrf` (readable, not HttpOnly) on session creation; the SPA mirrors the value into an `x-eliza-csrf` header on every state-changing request. Server compares header to cookie using `tokenMatches`. This is the same compare primitive already used at `eliza/packages/app-core/src/api/auth.ts:34`.

### 4.3 Bearer tokens

Bearer tokens become `kind: "machine"` sessions only. They carry explicit scopes (`scope=runtime.read`, `scope=connector.write`, etc.) and never receive CSRF exemption — they are exempt because they are not cookie-bound, but the route table marks which routes accept machine tokens at all.

The existing legacy-token path (`Authorization: Bearer <static>`) continues to work for one release as a "machine session with all scopes" so existing CI pipelines do not break — flagged as deprecated in logs and removed in the cycle after migration.

### 4.4 Refresh

Browser sessions are sliding: `lastSeenAt` updated on every request, `expiresAt` extended by min(remaining, 12h) up to the absolute cap. No refresh token endpoint — sliding cookie is the refresh.

## 5. First-Run Wizard

The wizard renders inside `apps/app/src/routes/onboarding/` and its API contract is `POST /api/auth/setup`. The flow branches on detected mode:

**Local install** (no cloud env): Step 1 is mandatory password creation (argon2id, min 12 chars, zxcvbn score >= 3). Step 2 offers optional Eliza Cloud SSO link. Step 3 ("connect a connector to log in via Discord/Telegram") is a deferred CTA shown after onboarding completes — it only becomes interactive once a connector is configured.

**Cloud-provisioned** (`ELIZA_CLOUD_PROVISIONED=1` and a verified bootstrap token): Step 1 is "paste your bootstrap token". Step 2 pre-populates the SSO link with the user already extracted from the bootstrap claims and asks for confirmation. Password is presented as an optional break-glass fallback — recommended but not required, with a clearly worded warning about what happens if cloud SSO is unreachable.

**Connector-owner**: never the first method. Always layered onto an existing identity, gated behind a confirmation that explains "this connector account will be able to log into this Eliza instance".

The wizard never proceeds without at least one viable login method. "Cloud SSO only" counts as viable if the bootstrap token verified against the cloud public key in the same wizard step.

## 6. Sensitive Routes — Rate Limit and Audit

Sensitive routes get a stricter limiter (`5/min/ip`, separate bucket from the existing 20/min auth limiter) and synchronous audit log writes. The list:

- `POST /api/auth/login/*` (all methods)
- `POST /api/auth/setup`
- `POST /api/auth/bootstrap/exchange`
- `POST /api/auth/owner/bind` and `POST /api/auth/owner/verify`
- `POST /api/auth/sessions/:id/revoke` and `DELETE /api/auth/sessions/all`
- `POST /api/auth/password/change`
- `POST /api/auth/machine-tokens` (create/rotate/revoke)
- `POST /api/connectors/*/credentials` (already partly gated)
- `POST /api/onboarding/*` (any onboarding write)
- `POST /api/dev/*` (already loopback gated, audit added for symmetry)

Audit destination is the dual-write described in §1.5. Logged fields: `actorIdentityId`, `action`, `outcome`, `ip`, `userAgent` (truncated to 200 chars), and a small action-specific `metadata` map (e.g. `{ method: "password" }` for login, `{ connector: "discord" }` for binding). Passwords, tokens, JWT bodies are never logged.

## 7. Hardware Fingerprint — Confirmed Demoted

`eliza/plugins/plugin-elizacloud/typescript/services/cloud-auth.ts` keeps the `deriveDeviceId()` flow only as a way for a fresh install to claim free-tier credits. The result is treated as an opaque identifier passed to the cloud signup endpoint; it never authorises anything inside the Eliza container. The auth layer treats the cloud API key obtained via device signup like any other cloud credential — usable for outbound LLM calls, not for inbound dashboard access.

## 8. File-by-File Change Inventory

### Runtime / API (`eliza/packages/app-core/src/api/`)

- `auth.ts` — extend with `ensureAuthSessionOrBootstrap()`, `requireScope()`, and a sensitive-route limiter. Existing `ensureCompatApiAuthorized` stays as the legacy bearer-only path.
- `auth/sessions.ts` (new) — Session CRUD, cookie parse/serialize, CSRF helpers.
- `auth/passwords.ts` (new) — argon2id wrapping (use `argon2` npm package, no homegrown crypto).
- `auth/bootstrap-token.ts` (new) — JWKS fetch + cache + token verify. RS256 only.
- `auth/cloud-sso.ts` (new) — OAuth-style redirect URLs, state nonce, code exchange against cloud.
- `auth/owner-binding.ts` (new) — slash-command pairing state machine and DM-link issuance.
- `auth/audit.ts` (new) — dual-write audit emitter.
- `auth-pairing-compat-routes.ts` — strip the cloud-provisioned bypass branches; route module split into `auth-routes.ts` (owns `/api/auth/*`) and a thin compat shim that forwards.
- `server-onboarding-compat.ts` — `isCloudProvisioned()` becomes metadata only, no auth implication. Onboarding writes go through `ensureAuthSessionOrBootstrap()`.
- `dev-compat-routes.ts` — add audit emit on the dev console-log read; behaviour otherwise unchanged.
- `compat-route-shared.ts` — add helpers for cookie parsing and IP normalisation if not already present.

### Persistence

- `eliza/packages/app-core/src/services/auth-store.ts` (new) — pglite-backed Identity / OwnerBinding / Session / AuditEvent repositories. Imports table definitions from `@elizaos/plugin-sql`'s schema barrel. No migration runner glue: `plugin-sql`'s `DatabaseMigrationService.discoverAndRegisterPluginSchemas` already picks up `Plugin.schema` at boot.
- `eliza/packages/app-core/src/services/cloud-jwks-store.ts` (new) — disk-backed JWKS cache.

### Schema (upstream `@elizaos/plugin-sql`)

- New schema files under `eliza/plugins/plugin-sql/src/schema/`: `authIdentity.ts`, `authOwnerBinding.ts`, `authSession.ts`, `authAuditEvent.ts`, `authBootstrapJti.ts`. Re-exported from `schema/index.ts`. Tables are flat with `auth_` prefix (`auth_identities`, `auth_owner_bindings`, `auth_sessions`, `auth_audit_events`, `auth_bootstrap_jti_seen`) — matches existing convention (`pairingAllowlistTable`, `pairingRequestTable`); no Postgres `auth.` schema namespace.
- Drizzle migration is generated by the existing `bun run migrate:generate` in `eliza/plugins/plugin-sql/src/`.

### Agent package (`eliza/packages/agent/`)

- `src/runtime/eliza.ts` — no changes; NODE_PATH invariant preserved. Auth layer is loaded on the existing module path.

### Plugin: Eliza Cloud (`eliza/plugins/plugin-elizacloud/`)

- `typescript/services/cloud-auth.ts` — split: keep `authenticateWithDevice()` for free-tier signup; new `getSsoRedirectUrl()` and `exchangeCodeForSession()` for the dashboard SSO flow.
- `typescript/services/cloud-bootstrap.ts` (new) — exposes the verify entrypoint to `app-core` via the existing service-port mechanism (no direct cross-package import).

### Connector plugins

- `eliza/packages/plugin-discord/` — new `pair` slash command and DM-link handler. Hooks into `auth/owner-binding.ts` via the runtime service registry.
- `eliza/packages/plugin-telegram/` — same shape, `/eliza_pair` command.
- `packages/plugin-wechat/` — same shape, deferred to P3 since lower-traffic.
- Other connectors get a tracking issue, not P0 work.

### UI (`apps/app/src/`)

- `routes/onboarding/setup.tsx` — new wizard.
- `routes/auth/login.tsx` — multi-method login (password, SSO button, "I have a pairing code" tab, "DM me a link" tab once bindings exist).
- `routes/settings/security.tsx` — sessions list, revoke buttons, machine-token management, password change, owner-binding management.
- `lib/api/auth.ts` (new) — typed client for the new endpoints.
- `lib/auth/csrf.ts` (new) — reads cookie, attaches header.
- Remove `localStorage` token reads from existing fetch wrappers; switch to credentials-include cookie auth. Bearer is reserved for explicit "machine token" call sites.
- `App.tsx` and the existing auth-status hook — query `/api/auth/me` instead of inferring from a local token.

### Electrobun shell (`apps/app/electrobun/`)

- `src/native/agent.ts` — no NODE_PATH changes. Add a small named-pipe mechanism so the desktop shell can pre-populate a session on first boot without the user retyping the password (loopback only, signed by the same in-process secret used for IPC). This is the "desktop trust" path.
- `src/native/auth-bridge.ts` (new) — implements the pipe.

### Scripts and CI

- `scripts/patch-deps.mjs` — unchanged; bun-exports patch invariant preserved.
- `scripts/dev-ui.mjs` and `eliza/packages/app-core/scripts/run-node.mjs` — unchanged; ports and namespace untouched.
- `.github/workflows/agent-review.yml` — add the new auth test matrix to the gate.
- `.github/workflows/agent-release.yml` — no behavioural change; the trust-gated build-first pipeline already covers the new files.

### Docs

- `docs/security/remote-auth-hardening-plan.md` — this doc.
- `docs/security/auth-flows.md` — sequence diagrams for each method, written during implementation.
- `AGENTS.md` of touched plugins — add the slash-command contract.

## 9. Migration Path

Existing users have only one credential today: a localStorage bearer token. The migration:

1. **First load after upgrade**: SPA detects an existing localStorage token, presents a one-shot "secure your account" modal. The user picks a password (argon2id) and optionally links Eliza Cloud. The legacy token is exchanged once for a fresh session cookie; that exchange is rate-limited (1 attempt per token) and emits an audit event.
2. **Grace window**: legacy bearer tokens keep working for 14 days post-upgrade as `kind: "machine"` sessions with `scope: ["legacy"]`. After that, they are rejected and the user must re-auth.
3. **Forced re-auth** is triggered the moment any of: password is set, owner binding is verified, cloud SSO is linked. The legacy token is invalidated immediately because we now have a real auth method — there is no reason to keep a weaker fallback live.

Cloud-provisioned containers running today have no real user-side credential. On upgrade their first dashboard load shows the bootstrap-token paste wizard. Until completed the dashboard is read-only and serves a single "finish setup" page. This is intentionally disruptive — it is the bug fix.

## 10. Phased Rollout

- **P0 — Cloud bypass closed**: ship `bootstrap-token.ts`, the verify path, the bypass-removal, the bootstrap exchange endpoint, the cloud dashboard "copy bootstrap token" affordance, and the matching wizard step. Everything else stays as-is. This alone fixes the audited critical gap.
- **P1 — Password + sessions**: argon2id, cookie+CSRF session model, login route, security-settings page. Browser-side localStorage token retired behind the legacy compat shim.
- **P2 — Cloud SSO**: OAuth-style redirect, JWKS verify, identity link to Cloud user. Wizard offers SSO as primary on cloud-provisioned containers.
- **P3 — Connector-owner**: Discord and Telegram first; slash-command pairing canonical; DM-link convenience login. WeChat follows.
- **P4 — Audit + per-route limit hardening**: rate-limit buckets, audit dual-write, sessions-list UI, machine-token issuance UI, legacy bearer fully removed.

Each phase is independently shippable. P0 by itself meaningfully changes the threat model.

## 11. Open Questions / Tradeoffs

- **JWT library choice**: `jose` is the obvious pick (zero deps, ESM, used widely), but `@panva/jose` versioning has bitten us in upstream elizaOS. Recommend `jose` pinned with patch-deps coverage.
- **argon2 binding**: native `argon2` requires a build step that has caused friction with Bun on Linux CI. `@node-rs/argon2` is a Rust binding with prebuilt binaries and is the safer choice. Confirm before P1 starts.
- **DB vs file split**: should sessions live only in pglite, or mirror to disk? Recommend DB-only for sessions (transient, regeneratable) and dual-write for password hash and audit. User to confirm.
- **Bootstrap token transport**: env var (`ELIZA_CLOUD_BOOTSTRAP_TOKEN`) vs control-plane API call on boot. Env var is simpler and matches how `STEWARD_AGENT_TOKEN` already flows. Recommend env var for v1.
- **Connector-owner uniqueness**: should a single Discord account be allowed to own multiple Eliza instances? Recommend yes (a user with 3 containers is normal), but enforce one-binding-per-(connector,externalId,instance) to prevent the same external account being bound to two identities on the same instance.
- **Recovery story**: if the user loses every login method (no password, cloud unreachable, connector accounts gone), what happens? Recommend a "recovery" subcommand on the CLI (`eliza auth reset`) that runs locally with filesystem access proof, regenerates the wizard, and forces full re-auth. Loopback-only.
- **Electrobun trust**: should the desktop shell auto-create a session on first boot? Recommend yes, scoped to loopback, but still requires the user to set a password before any non-loopback access works. This keeps the desktop UX zero-friction without weakening remote security.

## 12. Test Strategy

Mandatory before any phase ships.

### Unit (per module)

- `auth/passwords.ts`: argon2id round-trip, timing-safe verify, refusal of weak passwords.
- `auth/sessions.ts`: cookie parse edge cases, CSRF compare, sliding TTL math, expiry pruning.
- `auth/bootstrap-token.ts`: signature verify against fixture JWKS, `exp` rejection, `iss` rejection, `containerId` rejection, `jti` replay rejection, JWKS cache TTL, RS256-only enforcement (HS256 must reject), malformed token paths.
- `auth/audit.ts`: dual-write atomicity, rotation at 10MB, redaction of token-shaped strings.

### Integration (real pglite, no SQL mocks per project memory)

- Identity + Session repository round-trips.
- Bootstrap exchange: token in → session out → token replay rejected.
- Legacy bearer migration: old token in → modal triggered → password set → old token rejected.
- Sensitive-route limiter: 6 rapid POSTs to `/api/auth/login/password` produce one 429.

### End-to-end (Playwright against the dev server)

- First-run wizard, local install: password set, login works, refresh keeps session, logout invalidates.
- First-run wizard, cloud-provisioned: bootstrap paste, SSO link, fallback password optional path.
- XSS-steal regression: inject a script via a known DOM sink, confirm cookie is `HttpOnly` and unreadable.
- Proxy-bypass scenario: spin up a fake reverse proxy that strips cookies, confirm dashboard reverts to login. The point: container does not trust the proxy.
- Slash-command pairing: simulate a Discord message with the pair code (mock connector adapter), confirm binding lands.
- DM-link login: trigger DM issuance, click link in test browser, confirm session created.

### Cloud-container path — mandatory adversarial cases

- Token signed by an attacker-controlled key, same `kid`: must reject (JWKS hit miss).
- Token with valid signature but `containerId` mismatch: must reject.
- Token with valid signature and `containerId` but expired: must reject.
- Token re-presented after successful exchange: must reject (`jti` replay).
- JWKS endpoint down at boot: container starts in "wizard locked" mode, no bypass.
- Revocation list lists the current `jti`: must reject even before `exp`.

### CI integration

- `agent-review.yml`: add `bun run test:auth` (new script) to required checks.
- `agent-release.yml`: trust gate already covers; add a smoke test that boots a cloud-provisioned fixture container and confirms the dashboard is locked until bootstrap is exchanged.

## 13. Invariants Touched

- **NODE_PATH**: no — auth modules are plain TypeScript inside `app-core` and `agent`; no new dynamic plugin loads.
- **patch-deps**: yes if `jose` or `@node-rs/argon2` upstream packaging needs nudging; budget one patch entry per dep.
- **Electrobun boundary**: yes — `apps/app/electrobun/src/native/auth-bridge.ts` is new; startup try/catch guards preserved.
- **Ports / namespaces**: no changes. API stays 31337, UI 2138, namespace `eliza`. Cookie name is `eliza_*`.
- **CI workflows**: yes — `agent-review.yml` adds the auth test matrix; `agent-release.yml` adds the cloud-fixture smoke test.

## 14. Handoff

- **api-runtime specialist**: runtime/api files in §8, sessions, bootstrap, audit, sensitive-route limiter.
- **plugin-elizacloud specialist**: cloud SSO, bootstrap verify port, JWKS cache, dashboard "copy bootstrap token" affordance.
- **connectors specialist**: Discord and Telegram pair commands and DM-link issuance; WeChat in P3.
- **ui specialist**: wizard, login route, security settings, CSRF client, localStorage retirement.
- **electrobun specialist**: native auth bridge for desktop trust path.
- **ci specialist**: workflow updates and the cloud-fixture smoke test harness.
- **docs specialist**: sequence diagrams in `docs/security/auth-flows.md`.

The eliza-feature-coordinator owns sequencing; P0 is the only blocker for closing the audited gap and should ship before P1–P4 begin in parallel.
