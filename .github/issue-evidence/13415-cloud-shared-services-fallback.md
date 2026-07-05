# #13415 — cloud-shared services fallback-slop sweep: team-credential-pool + secrets

Slice of the #13415 sweep. Scope chosen: `team-credential-pool` (6 files) + `secrets`
(2 files), verified untouched by every in-flight fallback-sweep branch before starting.

## Before/after fallback census (touched files)

| file | before | after |
|---|---|---|
| team-credential-pool/bootstrap-env.ts | 1 blanket try/catch swallowing all faults → `return params.env` | 0 catches; faults propagate (fail closed); designed-empty (`!selected`) skips |
| secrets/secrets.ts | 1 unannotated catch, defaults | 1 catch annotated `J1` (batch partial-success); defaults verified domain-correct |
| secrets/encryption.ts | 2 unannotated rethrow catches | 2 annotated `J2` (context-adding rethrow with `cause`) |
| team-credential-pool/probe.ts | 2 unannotated catches | 2 annotated (`J1` boundary, `J3`/best-effort body-read) |
| team-credential-pool/service.ts | 2 unannotated catches | 2 annotated `J6`/`J2` (teardown / rethrow) |
| team-credential-pool/pool-deps.ts | 1 unannotated catch | 1 annotated `J6` (best-effort secret cleanup) |
| team-credential-pool/account-pool.ts | 0 catches (DI brain) | no change — already fails closed (deps throw, uncaught) |
| team-credential-pool/registry.ts | 6 catches | no change — already annotated (J4/J7 boundary) |

## Verdict table (every changed/annotated fallback)

| location | kind | verdict | rationale |
|---|---|---|---|
| bootstrap-env.applyPooledCredentialsToBootstrapEnv | blanket catch | **fail-closed-fix** | returned unchanged env on ANY error → could boot an agent missing a credential; now propagates internal faults, skips only the registry's designed-null |
| eliza-sandbox.ts:~620 caller comment | comment | **corrected** | stale "strict fallback: passes through unchanged" now describes fail-closed-vs-designed-empty |
| secrets.bulkCreate encrypt catch | catch | **J1** | per-item failure → structured `errors[]` (public partial-success shape); systemic repo failure is outside the try and propagates |
| encryption.decrypt DEK/GCM catches (x2) | catch | **J2** | rethrow `DecryptionError` with KMS error as `cause`; never decodes to partial/empty |
| probe.probePooledApiKey outer / body-read | catch | **J1/best-effort** | transport failure → structured probe result distinct from revoked(401/403)/healthy(200) |
| service.contribute/remove teardown catches | catch | **J6/J2** | best-effort secret teardown / rethrow; internal DB/vault failure still propagates |
| pool-deps.deleteAccount secret cleanup | catch | **J6** | best-effort orphan-secret cleanup on a already-committed delete |

## Focused test output (real, non-larp)

```
bun test --isolate <8 error-policy files>
 39 pass  0 fail  92 expect() calls  (8 files, 2.13s)
```
Each test drives the real exported function and asserts an internal failure PROPAGATES
(is not swallowed to empty/default) while a legitimately-empty/not-found case still
returns its designed empty result — the two stay distinguishable.

Regression: existing `team-credential-pool` + `secrets` suites — 50 pass / 0 fail.
No existing test pinned the removed swallow behavior.

## Other verification

- `bunx @biomejs/biome check <touched>` — clean.
- `bun run audit:error-policy-ratchet` — "no new fallback-slop in touched files" (emptyCatch/serverConsole 0→0 on all 7 changed source files).
- `bun run --cwd packages/cloud/shared typecheck` — 0 new errors in touched service files; pre-existing repo-wide drizzle-orm declaration noise (`dist/node_modules/drizzle-orm` missing types) unchanged and unrelated.

## N/A evidence rows

- UI screenshots — N/A (no UI touched).
- Model trajectories — N/A (no agent/model/prompt path touched).
- Audio — N/A.
- Runtime structured logs — N/A - service unit boundary only (behavior proven by the error-path unit tests above).
