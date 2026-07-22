# Claude Subscription Gateway — Agent Guide

Loopback-only benchmark model boundary that exposes JSON and SSE OpenAI Chat
Completions responses and performs each completion through a fresh official
Claude Agent SDK query. It exists to give elizaOS, Hermes, and OpenClaw the
same Claude-subscription transport while their own agent loops remain
responsible for policy and benchmark-tool execution.

## Commands

```bash
bun run test
bun run typecheck
bun run lint:check
bun run format:check
```

All default tests inject a deterministic SDK module and spend no model credits.
A live smoke must be an explicit operator action and is intentionally not part
of this package's test command.

## Layout

| Path | Role |
| --- | --- |
| `src/canonical.ts` | Validates requests and creates deterministic full-history prompts and hashes |
| `src/content-attestation.ts` | Validates reviewed content and derives role-partitioned, content-free proof |
| `src/claude-completion.ts` | Runs one fresh SDK query and captures MCP tool calls without executing benchmark tools |
| `src/fair-queue.ts` | Bounded per-harness round-robin scheduler |
| `src/hash-chained-jsonl.ts` | Crash-safe append-only private JSONL primitive |
| `src/audit.ts` | Redacted hash-linked audit projection and bounded test store |
| `src/replay-journal.ts` | Private exact-response journal for crash replay |
| `src/credential-rotation.ts` | Canonical account-pool rotation and credential-tier parity |
| `src/server.ts` | Authenticated loopback HTTP boundary |
| `src/cli.ts` | Private cohort readiness, signal handling, and redacted audit persistence |
| `tests/` | Offline unit and HTTP contract coverage |

## Invariants

- Never bind to a non-loopback address.
- Orchestrated cohorts must confirm a logged-in claude.ai subscription before
  the gateway process or any harness worker starts; status output is parsed and
  discarded, never logged.
- Never log or retain request content, tool arguments, bearer tokens, Claude
  credentials, account identity, or upstream error text.
- Every SDK request is a fresh session with settings discovery and built-in
  tools disabled.
- API-billing environment variables are rejected before CLI readiness, the SDK
  subprocess environment is scrubbed, and the SDK account response must prove
  a first-party Claude subscription. SDK init may report OAuth or the bundled
  CLI's `none` sentinel for keychain OAuth; every API-key source fails closed.
- MCP handlers capture proposed benchmark tool calls and return an
  acknowledgement only; they never invoke a benchmark implementation.
- Audit records carry the canonical reasoning-effort value actually passed to
  the SDK, including an explicit `null` when the request applied no override.
  Publication requires one non-null value per lane and one shared value across
  an Eliza/Hermes/OpenClaw cohort.
- Lifecycle cohorts stage their raw content contract in a `0600` file deleted
  after readiness. Before queueing or invoking the SDK, each request must carry
  the pinned hint exactly once in instruction roles and its public turn in a
  user role, with no hidden controls or workspace path in user content.
  Assistant/tool echoes are audit-only and never certify ingress.
- Audits record `parallel_tool_calls`, ordered message-role/content hashes, and
  role-partitioned counts. Cross-harness request hashes may differ because the
  native scaffolds intentionally differ.
- SSE is emitted from the same single queued SDK result as JSON responses; it
  must end with finish, usage, and `[DONE]` events.
- Authenticated `GET /v1/models` is a static chat-model compatibility endpoint
  and performs no SDK query. Embeddings remain unsupported and may never
  fabricate vectors.
- Every unexpected SDK module, tool, query, account, or stream exception is
  converted to a fixed typed code before it reaches HTTP or audit boundaries.
- Readiness, audit, replay, HMAC-key, content-contract, and storage paths are
  absolute operator-owned paths. Readiness is atomically published; audit and
  replay are append-only `0600` hash chains fsynced before response delivery.
  Startup repairs only an unterminated final record and rejects any committed
  corruption. Readiness may already be absent at shutdown.
- A successful provider result is fsynced to the private replay journal before
  its redacted audit record is fsynced, and the HTTP response follows both.
  Restarts replay the exact original response through the fair queue without a
  provider call; logical request IDs derive from namespace, lane ordinal, and
  canonical request identity.
- Linked `anthropic-subscription` accounts rotate through the canonical
  app-core broker using one stable logical session key. Ambient Claude Code
  keychain auth is allowed only when the linked pool contains zero accounts;
  configured-but-unselectable pools pause the cohort without an SDK call.
- The first subscription-quota or storage-reserve failure latches the process.
  It writes a distinct `pause_control` audit event and prevents further SDK
  calls until an operator restarts the gateway.
- SDK history serialization is a compatibility boundary, not raw Anthropic API
  equivalence; provenance must remain attached to every response.

See the repository root `AGENTS.md` for error policy and evidence requirements.
