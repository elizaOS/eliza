# Launch Readiness 10: Remote Interfaces

## Second-Pass Status (2026-05-05)

- Current: the main blockers are still accurate: cloud pair has no consume/promote/update-ingress path, no persisted expiry, and T9a data-plane resolution still happens before the final durable session id exists.
- Still open: phone manual pairing and chat mirroring are placeholders, remote scenarios are weak prompt-routing checks rather than transport/session tests, and multi-controller revoke/fanout e2e is missing.
- Launch gate: app-core pairing-token and LifeOps service tests cover pieces only; add cloud-to-T9a contract and two-client browser/data-plane tests before launch.

## Current state

Remote/second-device support exists in several partially overlapping layers:

- The desktop/lifeops control plane has a newer T9a remote session service with pairing-code checks, a persisted session ledger, owner-only start/list/revoke actions, and a pluggable data-plane resolver. By default, that resolver returns `data-plane-not-configured`, so the feature can create/track sessions but cannot produce a usable ingress URL without extra wiring.
- A legacy `REMOTE_DESKTOP` path still exists for VNC/SSH style remote desktop sessions. It is separate from the T9a `START_REMOTE_SESSION`/`LIST_REMOTE_SESSIONS`/`REVOKE_REMOTE_SESSION` flow and uses its own in-memory session store.
- Phone companion UI has QR payload decoding, a remote session iframe/input overlay, APNs intent handling, WebSocket input transport, and conservative ingress URL validation. Manual pairing and chat mirroring are explicit placeholders.
- Cloud API routes can create/list/revoke pending remote sessions, but I did not find a consume/promote/activate path that turns the returned pairing code into an active session with an ingress URL. The cloud schema also has no persisted expiry column even though the pair route returns an `expiresAt`.
- Multi-interface and auth handling are more mature for the general app server than for remote-control sessions: local loopback trust, session-cookie auth, static-token compatibility pairing, CORS allowlists, WebSocket auth, and SSE request handling all have focused tests.

## Evidence reviewed with file refs

- `plugins/app-lifeops/src/remote/remote-session-service.ts:1` - T9a service overview, session states, local-mode bypass, persisted ledger, default data-plane failure, pairing validation, list/revoke.
- `plugins/app-lifeops/src/remote/remote-session-service.ts:199` - data-plane resolver is called with `sessionId: "pending"` before the final session id is allocated.
- `plugins/app-lifeops/src/remote/pairing-code.ts:1` - in-process one-time 6-digit pairing codes with 5-minute TTL.
- `plugins/app-lifeops/src/remote/tailscale-transport.ts:1` - Tailscale/cloud/local transport types and `tailscale serve` probe/reserve/release helpers.
- `plugins/app-lifeops/src/actions/start-remote-session.ts:1` - owner-only T9a start action, pairing-code input, confirmation requirement, data-plane-not-configured response.
- `plugins/app-lifeops/src/actions/list-remote-sessions.ts:1` and `plugins/app-lifeops/src/actions/revoke-remote-session.ts:1` - owner-only session list/revoke actions.
- `plugins/app-lifeops/src/actions/remote-desktop.ts:1` - routing layer that sends `start/list/revoke` to T9a actions while keeping `status/end` on the legacy backend.
- `plugins/app-lifeops/src/actions/remote-desktop.ts:1` and `plugins/app-lifeops/src/lifeops/remote-desktop.ts:1` - legacy VNC/SSH/ngrok remote desktop implementation, mock backend, session expiry, listing, and revoke behavior.
- `packages/app-core/src/services/phone-companion/session-client.ts:1` - companion WebSocket client, token query parameter, input event sending, touch event conversion, base64 pairing payload decoder.
- `packages/app-core/src/components/phone-companion/RemoteSession.tsx:120` - ingress URL safety checks, viewer/input URL builders, iframe sandbox, input overlay wiring.
- `packages/app-core/src/components/phone-companion/Pairing.tsx:36` - QR scan path and currently non-functional manual pairing path.
- `packages/app-core/src/components/phone-companion/Chat.tsx:27` - placeholder chat mirror state pending T9a data plane.
- `packages/app-core/src/components/phone-companion/PhoneCompanionApp.tsx:61` and `packages/app-core/src/services/phone-companion/push.ts:51` - APNs registration and `session.start` payload routing into the remote session view.
- `cloud/apps/api/v1/remote/pair/route.ts:1` - authenticated cloud pairing route, sandbox/org verification, 6-digit pairing code, hash persistence, returned TTL.
- `cloud/apps/api/v1/remote/sessions/route.ts:1` and `cloud/apps/api/v1/remote/sessions/[id]/revoke/route.ts:1` - cloud active-session list and revoke routes.
- `cloud/packages/db/schemas/remote-sessions.ts:18`, `cloud/packages/db/repositories/remote-sessions.ts:11`, and `cloud/packages/db/schemas/migrations/0068_add_remote_sessions.sql:1` - cloud remote session table and repository behavior.
- `packages/app-core/src/onboarding/server-target.ts:1`, `packages/app-core/src/onboarding/mobile-runtime-mode.ts:1`, `packages/app-core/src/components/shell/RuntimeGate.tsx:417`, `packages/app-core/src/state/useOnboardingCallbacks.ts:1`, `packages/app-core/src/state/persistence.ts:1`, and `packages/app-core/src/state/startup-phase-restore.ts:1` - local vs remote vs cloud vs hybrid target routing and persisted active server restore.
- `packages/app-core/src/api/auth-pairing-compat-routes.ts:25` - local static-token pairing, same-machine bypass, remote code flow, and cloud-provisioned disablement.
- `packages/app-core/src/api/auth-session-routes.ts:1`, `packages/app-core/src/api/auth/auth-context.ts:67`, `packages/app-core/src/api/auth/sessions.ts:29`, and `packages/app-core/src/api/auth.ts:1` - session auth, bearer fallback, CSRF, trusted local handling.
- `packages/app-core/src/api/trusted-local-request.ts:189` and `packages/app-core/src/api/server-cors.ts:10` - loopback trust and CORS allowlist behavior.
- `packages/app-core/src/api/client-base.ts:216`, `packages/app-core/src/api/client-base.ts:390`, and `packages/app-core/src/api/client-base.ts:660` - REST token headers, WebSocket auth/reconnect/queueing, and SSE chat parsing.
- `packages/agent/src/api/server-helpers-auth.ts:680` and `packages/agent/src/api/server.ts:3712` - WebSocket upgrade/auth validation, origin checks, client tracking, PTY subscription/input handling, cleanup.
- `test/scenarios/remote/*.scenario.ts` - remote scenario coverage inventory for desktop, pair, mobile controls, revoke, and cloud SSO paths.

## What I could validate

- Targeted lifeops tests pass:
  - `bunx vitest run --config vitest.config.ts test/remote-session-service.test.ts src/remote/tailscale-transport.test.ts test/remote-desktop-action.test.ts`
  - Result: 3 files passed, 36 tests passed.
- Targeted app-core remote/auth/interface tests pass:
  - `bunx vitest run --config vitest.config.ts src/services/phone-companion/session-client.test.ts src/api/auth-pairing-compat-routes.test.ts src/api/server-cors.test.ts src/components/settings/SecuritySettingsSection.test.tsx src/components/shell/Header.test.tsx src/state/usePairingState.test.ts`
  - Result: 6 files passed, 78 tests passed.
- Static review confirmed owner-only gating for lifeops T9a actions and remote desktop owner wrapper.
- Static review confirmed local loopback trust has guardrails around host, origin, referer, proxy headers, cloud-provisioned mode, and fetch-site.
- Static review confirmed app-core HTTP, WebSocket, and SSE clients have token propagation, timeouts/retry behavior, and bounded WebSocket send queueing.
- Static review confirmed the phone companion remote session view rejects credentials, metadata hosts, and public plaintext `ws://` ingress URLs.
- Static review confirmed cloud remote routes verify org ownership before pair/list/revoke operations.

## What I could not validate

- Real second-device operation with iOS/Android camera scanning, APNs delivery, native lifecycle, and hardware touch input.
- A real Tailscale, ngrok, noVNC, or cloud ingress data plane. The default T9a data-plane resolver deliberately returns no ingress URL.
- End-to-end cloud pairing, because I did not find a cloud consume/promote/activate route or tests that exercise one.
- Live multi-device conflict handling, including two controllers, revoking while an input socket is open, and stale iframe/input teardown.
- Remote browser password/session behavior from a non-loopback client on another device.
- OAuth/SSO remote access behavior for cloud Discord/Gmail scenarios.
- Scenario-runner validation for `test/scenarios/remote`; the files read more like launch QA prompts/routing checks than deterministic transport tests.

## Bugs/risks P0-P3

### P0

- None found in this bounded review.

### P1

- Cloud pairing is not visibly end-to-end. `cloud/apps/api/v1/remote/pair/route.ts:1` creates a pending session and returns a 6-digit code, but no route/repository path was found that consumes the code, promotes the session to active, writes `ingress_url`, or binds the cloud session to the desktop T9a session. The returned `expiresAt` is not backed by a persisted `expires_at`, so stale pending sessions can remain listable until manually revoked.
- T9a data-plane resolution happens before the durable session id exists. `plugins/app-lifeops/src/remote/remote-session-service.ts:199` calls `dataPlane.resolve({ sessionId: "pending", ... })`, then creates the real `session-${Date.now()}...` id later. A real data plane would be unable to mint session-scoped ingress or revocation metadata against the persisted session id.
- Phone companion manual pairing and chat are not launch-ready. `Pairing.tsx` returns a manual-handshake-not-available error, and `Chat.tsx` is a placeholder for future SSE/composer work. A user without QR/APNs payload delivery has no working manual path into a remote session.

### P2

- Tailscale transport helpers are implemented and tested, but they are not wired into the default T9a `RemoteSessionService`; the default launch path still returns `data-plane-not-configured`.
- Legacy `REMOTE_DESKTOP` and newer T9a remote sessions coexist with different stores, commands, names, and lifecycle semantics. `REMOTE_DESKTOP` routes some operations to T9a and others to legacy code, which raises user-facing status/revoke confusion risk.
- Remote scenario coverage is thin. One pair scenario expects an unrelated `LIST_ACTIVE_BLOCKS` action, and the suite does not validate QR payloads, APNs, noVNC rendering, companion input transport, cloud pairing promotion, or revoke effects.
- Security-critical URL builders in `RemoteSession.tsx` are private and were not covered by direct tests in the targeted run. The code looks careful, but ingress URL validation should be locked with tests before exposing remote control broadly.
- Session conflict behavior is basic. List/revoke filter by state, but there is no evident active-session limit, controller arbitration, or test proving that revocation closes/rejects existing input sockets.
- `SessionClient` and viewer URLs carry session tokens in query parameters. That may be necessary for browser WebSocket/iframe integration, but it should be threat-modeled because URL query strings can leak through logs, crash reports, or intermediaries.

### P3

- Runtime target persistence is split across `RuntimeGate` and `useOnboardingCallbacks`; non-Android local completion clears the active server in one path but persists a local active server in another. This is adjacent to remote/cloud routing and can complicate debugging device state.
- Header/security settings tests cover display states, but the review did not include a live remote browser session proving password setup, login, session listing, and revoke across interfaces.
- The phone companion native pairing persistence stores only `deviceId` and `agentUrl`; there is no reviewed evidence of refresh, rotation, or stale pairing cleanup for remote sessions.

## Codex-fixable work

- Change `RemoteSessionService.startSession` so the real session id is allocated before `dataPlane.resolve`, then persist the resolver result against that id. Add a regression test proving the resolver receives the final id.
- Add a real cloud session lifecycle API or repository method for pairing-code consume, TTL enforcement, active promotion, ingress URL update, and stale pending cleanup. Add an `expires_at` or equivalent expiry field.
- Wire a launch data plane into T9a, even if initially Tailscale-only, so the owner action can return a usable ingress URL instead of the default failure.
- Export or test via public behavior the `RemoteSession.tsx` ingress validation and URL-building rules.
- Replace the placeholder remote pair scenario expectation and add deterministic mock-data-plane scenarios for start/list/revoke.
- Add manual pairing handshake support in phone companion or hide/disable the manual path until the data plane exists.
- Normalize legacy vs T9a remote desktop status/list/revoke naming so users do not need to know which store a session lives in.

## Human multi-device QA needed

- Pair a real phone to a desktop agent through the intended launch path: QR/APNs payload, iframe load, touch input, disconnect, reconnect.
- Repeat the same flow over each intended ingress type: local LAN/private `ws://`, Tailscale `wss://`, and cloud ingress.
- Verify cloud account/org boundaries with two orgs and two agents: pair/list/revoke should never cross org or agent ownership.
- Test remote password setup/login/session revoke from another device on the same network and from a non-local network.
- Start two companion devices against the same desktop session and verify expected controller behavior, visual state, and revoke behavior.
- Validate expired, wrong, reused, and revoked pairing codes on real devices.
- Verify that revoke immediately prevents further input and that any existing viewer/input connection shows a clear terminal state.
- Check mobile lifecycle: app background/foreground, push notification cold start, network change, and device sleep.

## Recommended automated coverage

- Cloud API behavioral tests for pair/list/revoke, including org scoping, TTL expiry, stale pending exclusion, idempotent revoke, and invalid agent/session ids.
- Contract or integration test from cloud pair code to desktop T9a consume/start, including code format, hash semantics, requester identity, ingress URL update, and active promotion.
- Unit test proving T9a data-plane resolver receives the final persisted session id.
- RemoteSession URL validation tests for metadata hosts, credentials, public plaintext `ws://`, private/localhost plaintext, `wss://`, query/path joining, viewer URL, and input URL.
- Mock noVNC/WebSocket integration test: pairing payload opens `RemoteSession`, input overlay sends expected JSON events, reconnect is bounded, and revoke rejects input.
- Scenario-runner updates that assert owner-only start/list/revoke behavior with both `data-plane-not-configured` and mock ingress success.
- Runtime routing tests for `RuntimeGate` and onboarding callbacks across local, remote, cloud, cloud-hybrid, iOS, and Android persistence.
- WebSocket auth tests covering header token, query token disabled/enabled, cloud-provisioned unauthenticated rejection, origin rejection, and PTY input subscription enforcement.
- Conflict tests for simultaneous starts, two controllers on one session, revoke during active socket, expired code, wrong code, and reused code.

## Changed paths

- `launchdocs/10-remote-interfaces.md`
