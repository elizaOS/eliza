# `@elizaos/agent`

Standalone elizaOS agent and HTTP backend. Plugin routes can be registered on `AgentRuntime` and are served by the agent’s HTTP stack.

## Documentation

- **Paid HTTP routes (webhooks, plugins):** see the docs site section on [webhooks and routes](https://docs.elizaos.ai/plugins/webhooks-and-routes).
- **x402 micropayments on plugin routes:** configured through the runtime's `x402` config block and the `X402_API_KEY` environment variable (see `packages/agent/src/runtime/eliza.ts`).

## Local development

From this package:

```bash
bun install
bun run typecheck
bun run test
```

See `package.json` for `build`, `lint`, and other scripts.

## Research tasks

`ResearchTaskExecutor` requires a provider registered for
`ModelType.RESEARCH`. Provider absence, rejection, or an empty report returns an
unsuccessful `TaskResult` with a stable `errorCode`; it never falls back to
ordinary `TEXT_LARGE` synthesis and labels that output as research.

## Message-interaction session persistence

`FileMessageInteractionSessionStore` is the durable single-host adapter for
core's message-interaction session authority. It serializes independent local
processes, writes a 0600 regular file through same-filesystem fsync and atomic
rename, fails fast on corruption and symlinks, qualifies Linux lock owners by
boot/process generation, and generation-fences stale takeover and release with
an atomically published transition marker. A complete owner inode is fsynced
before no-replace hardlink publication; malformed owners have a bounded
recovery ceiling, while a live PID that cannot be generation-qualified fails
closed. An abandoned transition marker also fails closed because portable
filesystems cannot conditionally unlink a pathname generation; an operator may
remove it only after stopping every store user and verifying that no host
process owns the store. Operations report
`INTERACTION_STORE_RECOVERY_REQUIRED` and do not mutate state while that marker
remains; this state has no bounded automatic recovery. The marker path is
reported in `error.context.markerPath`; with the default filename it is
`<stateDirectory>/message-interaction-sessions.v1.json.lock.transition`.
Recovery requires stopping every process that uses the store, verifying that
none owns the adjacent `.lock` owner file, removing that exact `.transition`
path, fsyncing the state directory, and only then restarting store users. Its
boundary is one machine and one state directory. Multi-host deployments must
supply a transactional database implementation of
`MessageInteractionSessionStore` and use the session replay key as the effect or
outbox idempotency key.

Transition cleanup reports machine-distinct retry outcomes. A failure during
pre-operation stale recovery is
`INTERACTION_STORE_RECOVERY_CLEANUP_FAILED` with `committed: false`; a failure
after the durable transaction commit is
`INTERACTION_STORE_COMMITTED_CLEANUP_FAILED` with `committed: true`, so callers
must not retry the mutation. Every other release failure after the durable write
is `INTERACTION_STORE_COMMITTED_RELEASE_FAILED` with the same no-retry contract;
combined operation/release failures retain the release code and recovery
context. If publication sees a transition marker after linking its complete
owner, no transaction starts. Offline recovery must additionally verify the
reported owner token/inode, remove both the exact marker and owner paths, fsync
the parent directory, and restart. Owner-candidate cleanup failure is likewise
typed as pre-mutation (`INTERACTION_STORE_OWNER_CANDIDATE_CLEANUP_FAILED`,
`committed: false`) whether or not the candidate was published; a published
owner is safely detached when possible and `context.published` records which
case occurred.
After the state temp is renamed, a parent-directory sync failure reports
`INTERACTION_STORE_COMMIT_AMBIGUOUS` with `committed: "unknown"`; a close
failure after successful sync uses the same code with `committed: true`.
Both are non-retryable and require reading the reported state file to reconcile
the persisted session outcome. If lock unlink and transition cleanup both fail,
the committed cleanup error retains the unlink cause, cleanup error, marker,
lock identity/token, and exact offline recovery authority.

The file authority durably commits an effect before dispatch. If the process
dies after that commit but before retaining the receipt, the session remains
`committed` for operator reconciliation; it is never lease-transferred,
automatically retried, or revoked as if cancellation succeeded. The store lists
ambiguous commits and accepts only a verified receipt to reconcile them without
re-execution. Completed receipts are retained for seven days and unreconciled
commits for thirty days by default, after which bounded collection prevents
permanent capacity exhaustion.

The bundled `eliza` plugin registers `MessageInteractionHostService` as the one
runtime authority connectors resolve through `MESSAGE_INTERACTION_HOST_SERVICE`.
Connectors submit capability profiles and trusted render bindings to `prepare`,
then send authenticated inbound provider receipts to `consume`. Only host-owned
effect handlers execute retained operations; completed receipts preserve the
provider event, canonical inbound event, audit id, and app-state proof for replay.

## Approval-bound plugin installation

`installPlugin` always installs the canonical npm package declared by the
registry (`plugin.npm.package`), even when lookup used a display name or alias.
Existing callers may continue passing a version string as the third argument.
Security-sensitive callers can instead bind the package and exact version they
showed an operator for approval:

```ts
const result = await installPlugin("friendly-registry-alias", undefined, {
  expected: {
    packageName: "@vendor/canonical-plugin",
    version: "2.4.1",
  },
});
```

The installer rejects a changed package or version before creating the install
directory or executing a package manager. A bound install uses that exact npm
package/version and does not silently fall back to a local workspace or moving
Git branch. Successful results include `provenance` identifying the actual
`local`, `npm`, or `git` source. npm/Bun lock integrity and resolved tarball
metadata are returned when available; unavailable integrity stays `null`, and
Git installs report the cloned commit.

## x402 at a glance

Paid routes set `x402` on a `Route`. The middleware returns **402** with payment options and accepts on-chain proofs, facilitator payment IDs, or standard payment payloads (`PAYMENT-SIGNATURE` / `X-Payment`), then verifies and settles through a facilitator before running the handler.

For environment variables, events, replay protection, and buyer guidance, use the linked docs above.

## Production chat latency evidence

`bun run --cwd packages/agent perf:cerebras-chat` drives the real
`generateChatResponse`/AgentRuntime/PGLite path. Run from a clean committed
checkout. It requires an explicitly verified `ELIZA_CEREBRAS_CHAT_MODEL` and
`CEREBRAS_API_KEY`; do not treat an old model name or historical report as
current availability proof.

The command now requires a real configured embedding service:
`OPENAI_EMBEDDING_URL`, `OPENAI_EMBEDDING_MODEL` and
`OPENAI_EMBEDDING_DIMENSIONS`. Set `OPENAI_EMBEDDING_API_KEY` through the normal
local environment if that service needs authentication. Without the explicit
endpoint, the Cerebras adapter uses feature-hash embeddings, which cannot
certify production embedding latency. The report must contain a successful
embedding execution and its actual outbound request.

Select the experiment explicitly:

- `ELIZA_CEREBRAS_CACHE_MODE=automatic` omits optional routing keys; ordinary
  provider prefix caching remains available.
- `ELIZA_CEREBRAS_CACHE_MODE=existing` retains the production prefix strategy.
- `ELIZA_CEREBRAS_CACHE_MODE=conversation` applies an opaque key scoped to the
  agent, room, model, stage and stable prefix after core cache-plan assembly.

The two keyed modes require
`ELIZA_CEREBRAS_CACHE_KEY_CAPABILITY_CONFIRMED=true` **after independently
confirming account support**. This flag records the operator's attestation; it
is not an account-capability probe. These overrides belong only to the
benchmark and do not change production defaults or another provider's policy.

Set `ELIZA_CEREBRAS_CHAT_PATH=direct` or `gateway`. For gateway runs, configure
`CEREBRAS_BASE_URL` to the authorized compatible endpoint and set
`ELIZA_CEREBRAS_GATEWAY_SOURCE_REVISION` to its independently attested deployed
SHA. The command checks the SHA's syntax, not remote deployment provenance.
The text and embedding endpoints must not contain embedded credentials,
queries or fragments.

`ELIZA_CEREBRAS_CHAT_CONDITION` selects the workload:

- `rolling-history`: all measured turns append to the existing conversation.
- `fresh-room`: each sample starts a new conversation on the same runtime.
  This is **not** proof of a cold provider cache; a shared prefix may be reused.
- `post-idle`: each sample gets its own primed conversation, then resumes after
  a shared idle wait. `ELIZA_CEREBRAS_CHAT_IDLE_MS` defaults to 360000. Reports
  include the actual interval since each room's prior completion.

`ELIZA_CEREBRAS_CHAT_SAMPLES` defaults to 30 and
`ELIZA_CEREBRAS_CHAT_WARMUPS` to 3. A post-idle run adds one priming turn per
sample; the existing cancellation probe also makes a live call. Compare matched
model, tier, endpoint, embedding service, settings and workload across runs.
Classify actual cache misses/reuse from upstream cached-token counts rather
than labels, and report unavailable upstream metrics explicitly. There are no
CI latency thresholds.

Set `ELIZA_CEREBRAS_CHAT_REPORT` to a protected artifact path. Newly created
reports use mode 0600 and contain complete synthetic prompts, SDK request
bodies, outputs, model execution timings, provider spans and persistence
receipts. Authorization headers are never recorded. First visible text,
response headers, foreground completion and background quiescence are distinct;
HTTP header latency is not provider TTFT. Missing queue time and acoustic audio
latency are explicitly unavailable. Inspect artifacts before publishing.

This text-runtime command does not certify app rendering, audio playback,
real connector delivery or a separate deployed gateway's identity. The strict
proof checks abort on a failed sample, so a successful report's error rate is
zero; retain the failed command/log separately rather than dropping it from a
comparison. #17072 still requires current live production evidence, concurrent
and resumed-session correctness, and any reproduced bottleneck's matched
before/after result. Preparing this command alone does not complete the issue.

For an installed desktop native embedding model, set
`ELIZA_CEREBRAS_EMBEDDING_MODE=native`, `MODELS_DIR`,
`LOCAL_EMBEDDING_MODEL`, and `LOCAL_EMBEDDING_DIMENSIONS` instead of the HTTP
embedding settings. This runs the canonical `ensureLocalInferenceHandler`
boot and selects its `eliza-local-inference` embedding handler explicitly;
it never substitutes a benchmark embedding implementation or silently falls
back to the OpenAI-compatible synthetic embedding path. The report records
model and fused-library paths and SHA-256 hashes separately from HTTP wire
evidence. Every returned vector must have the configured dimension and finite,
nonzero values. Native readiness does not prove remote gateway readiness.

For a controlled provider-only comparison after collecting a successful keyed
runtime report with at least 30 sample requests, run:

```bash
ELIZA_CEREBRAS_CACHE_KEY_CAPABILITY_CONFIRMED=true bun --conditions=eliza-source packages/agent/scripts/cerebras-cache-wire-replay.ts /path/to/runtime-report.json /path/to/replay-report.json
```

The replay preserves every original message, tool, schema and model setting;
only the optional cache hint changes. Shared-prefix and conversation hints
use a fresh run scope. Mode order rotates for each matched request. It records
complete SSE responses and every HTTP attempt, paces calls three seconds apart,
and permits at most three attempts per request. A longer-than-60-second
`Retry-After` stops the run instead of starting an unbounded retry loop.
Automatic prefix caches may already be warm, and routing hints cannot guarantee
independent cache residency. Replay results therefore describe a provider
experiment, never app/runtime/gateway acceptance.

The chat command's `wallMs` includes `generateChatResponse`'s room background
drain. Use `firstVisibleTextMs` and the runtime's response-finalization spans
for delivery timing. `backgroundQuiescenceMs` measures only an additional
residual drain after command return. Report HTTP 429 and transport-attempt
counts separately from completed-turn success; successful runs do not erase
failed preflights or recovered retries.
