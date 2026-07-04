# #11536 E2 residual — per-spawn scoped model-token leases + revocation + credit-gate

Replaces the single static `ELIZA_MODEL_GATEWAY_TOKEN` every spawned coding
sub-agent inherited (E2 spawn seam, #11651) with a **per-spawn, TTL-bound,
budget-scoped, revocable lease** minted at spawn and killed at task end. A leaked
child env can no longer spend beyond its task budget or outlive its task.

## What changed

- `plugins/plugin-agent-orchestrator/src/services/model-gateway-lease.ts` (new) —
  `ModelGatewayLeaseBroker` interface, `HttpModelGatewayLeaseBroker` reference
  impl (SSRF-guarded `POST` mint / `POST <url>/<leaseId>/revoke`), `LeaseCreditGate`
  seam + a default that reuses the existing `spend-allowance` per-session budget
  (no second ledger), `mintSpawnLease()` fail-closed decision logic, and
  `configureModelGatewayLease()`/`resetModelGatewayLease()` injection points.
- `services/acp-service.ts` — mint the lease in `spawnSession` before the
  transport branch (rolls back the reserved session on a fail-closed refusal);
  `buildEnv` injects the leased token (falls back to static); `emitSessionEvent`
  revokes on every terminal event (`stopped`/`error`/`cancelled`); `stop()`
  revokes survivors on teardown.
- `services/model-gateway.ts` — `applyModelGatewayEnv` now strips all parent-only
  `ELIZA_MODEL_GATEWAY_*` admin vars from the child (the ELIZA_ prefix rule was
  forwarding the privileged, mint-capable static token into every child — the
  exact leak leasing closes).

## Config (vendor-neutral, no broker branding)

| Var | Effect |
|---|---|
| `ELIZA_MODEL_GATEWAY_URL` + `_TOKEN` | gateway mode (unchanged, #11651) |
| `ELIZA_MODEL_GATEWAY_LEASE_URL` | broker lease endpoint — turns per-spawn leasing on |
| `ELIZA_MODEL_GATEWAY_STRICT` | `1` ⇒ refuse to hand out a static token when a broker is expected but absent / mint fails |

Broker shape: `POST <lease-url>` (bearer = gateway token) → `{ token, expiresAt, leaseId }`;
revoke `POST <lease-url>/<leaseId>/revoke`. Any broker speaking this shape works
(Steward is the reference broker, not a dependency).

## Acceptance

- **No raw provider key in the sub-agent env dump** — asserted (stays true from
  #11651; strengthened: the static gateway token itself is now also stripped).
- **Revoking the lease kills sub-agent model access mid-task** — proven with a
  fake gateway that honors revocation: `callModel(leasedToken) === 200` before,
  `=== 401` after the terminal event fires the revoke.

## Tests — all real, fail-without-fix

`__tests__/unit/model-gateway-lease.test.ts` — 16 tests:

- mint at spawn: child carries the **leased** token, not the static one; static
  `ELIZA_MODEL_GATEWAY_*` vars stripped; mint TTL == task timeout, scope
  `model-invoke`; token never logged.
- revoke on **all three** terminal exit paths (`stopped`/`error`/`cancelled`,
  exactly-once/idempotent) + real `closeSession` stop path + `stop()` teardown;
  each proven to flip `callModel` 200→401.
- TTL expiry: gateway rejects the token past `expiresAt` with no explicit revoke;
  `isLeaseExpired` boundary.
- credit-gate refusal: insufficient-budget gate refuses **before** minting — no
  mint, no native client, no orphan session record (fail-closed).
- no-broker fallback: gateway on, no broker, non-strict ⇒ static token (unchanged).
- strict fail-closed: no broker ⇒ spawn refused; broker mint fails ⇒ spawn
  refused; non-strict mint failure ⇒ static-token fallback.
- HTTP reference broker: real loopback server — mint over the wire (bearer =
  gateway token, body has sessionId/ttlMs/scope), child gets server-minted token,
  revoke hits `POST /lease/<id>/revoke`.

```
bunx vitest run __tests__/unit/model-gateway-lease.test.ts
  Test Files  1 passed (1)
       Tests  16 passed (16)

# full plugin unit suite (regression, incl. the #11651 gateway-env suite):
bun run --cwd plugins/plugin-agent-orchestrator test:unit
  Test Files  119 passed (119)
       Tests  1309 passed (1309)

bun run --cwd plugins/plugin-agent-orchestrator typecheck   => pass
bun run --cwd plugins/plugin-agent-orchestrator lint:check  => 281 files, clean
```

Fail-without-fix spot-checks (reverting the change reddens the matching test):
removing the parent-var strip fails "leased token replaces static" (static
`ELIZA_MODEL_GATEWAY_TOKEN` survives); removing the `emitSessionEvent` revoke
fails all three revoke tests (`callModel` stays 200); removing the credit-gate
throw fails the refusal test (a lease is minted).

Domain artifact (`N/A` for UI): the lease is the artifact — mint request,
`{ token, expiresAt, leaseId }`, and the 200→401 model-access flip are asserted
directly in-test against the fake/loopback gateway.
