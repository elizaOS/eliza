# Staging inference admission Worker

This Worker exports the canonical API `InferenceAdmissionGate` in a separate
isolate. It has no public admission or accounting route. Actor names, persisted
receipts, quotas, revocation generations and lease state retain their existing
ownership.

The checked-in configuration describes the post-transfer staging topology:
the API retains the transfer tombstone, its admission binding points here, and
this Worker has the SQLite class declaration and self-binding. Preserve the
existing namespace; creating a replacement would split quota and financial
state. Production configuration is unchanged.

Accounting recovery stays on the API through the private
`InferenceRecoveryService` binding. The service validates the canonical recovery
context and awaits actor-owned balance-fence callbacks. Failure retains the lease
for the existing retry path. Database, cache, mail and accounting credentials stay
with the API; this Worker does not need copies of those credentials. Funded
admission remains disabled by default.

## Validation

Use the pinned toolchain and normal built workspace dependencies. From the root:

```bash
bun packages/cloud/admission-worker/verify-staging-contract.ts
bun run --cwd packages/cloud/api test inference-recovery-service
bun run --cwd packages/cloud/api test inference-rate-deadline
bun run --cwd packages/cloud/shared test inference-admission-recovery.pglite
bun run --cwd packages/cloud/shared test sdk-provider-telemetry.integration
bun packages/cloud/api/node_modules/wrangler/bin/wrangler.js deploy --config packages/cloud/admission-worker/wrangler.toml --dry-run --outdir test-results/admission-worker-candidate
```

The source contract checks declarations, bindings, aliases and environment parity.
The RPC test checks callback transport; PGlite tests exercise canonical accounting.
Neither establishes live namespace continuity, deployment readiness or a latency
distribution. Verify the current namespace, receipts and exact deployed modules
through the operator's retained acceptance evidence before any lifecycle change.

A namespace transfer affects every actor. Keep the API class and tombstone through
observation and inventory external consumers before changing them. Reversal must
transfer the same namespace back, restore bindings and verify stored receipts;
ordinary version rollback cannot undo the transfer. Never delete and recreate the
class as rollback. See the Cloudflare documentation for
[namespace transfers](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
and [rollback constraints](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
