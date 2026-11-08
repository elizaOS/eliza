# ValhallaOS V38: AI-Cloud OS foundation

Status: proposed isolated foundation, not a deployed V38 release.

## Product and topology
The OS shell, conversational interface and scoped memory are primary. Trading is optional. Zeus coordinates policy and context; worker nodes execute bounded authorized jobs. Keep the interactive response path independent of background queue availability. Models, queues and workers are replaceable adapters behind stable user-facing services.

## Staircase policy
Check scoped, fresh memory first. Route triage and extraction to eligible local providers before cloud providers. Grounded SEARCH must not silently degrade into ungrounded reasoning. Keep local-only data local. A cloud adapter is treated as metered unless explicitly configured otherwise; allowMetered must come from trusted server policy. Adapter labels do not establish account access, model availability or actual cost.

The isolated foundation is src/services/v38/foundation.mjs. It preserves routePrompt and routeAndExecute result shapes, but existing callers still require migration to server-authenticated or server-issued guest context. It does not replace src/services/modelRouter.ts and does not authenticate requests itself. Authorize, result-validation, node-enrollment, dispatch and provenance policies are mandatory injected gates; production must not use the permissive fixtures from tests.

Cache keys include subject/tenant scope, task type, privacy, grounding and memory/conversation revisions. Cache outages do not block otherwise authorized inference. No durable memory implementation is included. Source URLs and grounded=true are metadata, not proof of truth; real validation must corroborate authorized evidence. No zero-latency or sub-second guarantee is made.

## Worker protocol and recovery
Enroll owner-authorized nodes using trusted Ed25519 public keys and explicit capabilities. Bind every attempt to node ID, task ID, scope, input hash and expiry. Use resultSigningBytes exactly for the current JavaScript wire format. Signatures prove attribution, not truth. Cross-language canonicalization needs its own compatibility review.

Each registered transport has a persistent listener. This prototype allows one in-flight task per node and concurrent work on separate nodes. Timeout cleanup and replay protection are attempt-scoped. Three consecutive task/protocol failures quarantine a node and invoke a notification callback, never a shell command. Recovery belongs to a separately authorized, bounded supervisor; no sudo or automatic arbitrary self-rewriting.

Registries and pending attempts are in memory. They are NOT durable BullMQ leases, distributed scheduling or persistent idempotency. Add those before relying on Zeus restarts or multiple coordinators. No worker result is written to memory automatically. Future adapters must implement authenticated transports, owner consent, resource limits and explicit source access; localhost is the executing machine, not an arbitrary remote node.

## Migration and release gates
1. Restore and verify public conversation separately; this foundation does not fix or publish the website.
2. Add real backend provider, provenance, memory and authorization adapters; never put provider secrets in client configuration.
3. Add durable task state, leases, budgets, retry classification and staged repair policies.
4. Add TypeScript declarations/bridges and migrate actual callers without removing their contracts.
5. Build/typecheck/test in the repository's Node 24.15.0 and Bun 1.4.2 workspace; run bounded staged live tests before a specific deployment approval.

Develop contains service source; docs/site is the separate current public-site branch. The supplied OverseerDesk.tsx and HeroSection.tsx paths were not found on develop and are not fabricated here. git origin develop is invalid; review-branch pushes use git push origin <review-branch>. This work does not deploy an admin console, activate trading, register remote nodes, upgrade hosting plans or promise passive income.

## Test scope
Run node --test src/services/v38/foundation.test.mjs. Local tests use injected providers/cache policies, fake transports and real generated Ed25519 keys. They do not verify live models, browser behavior, full workspace compatibility, BullMQ, persistent memory, deployment or provider billing caps. A caller timeout cannot guarantee that an uncooperative adapter stops underlying computation.
