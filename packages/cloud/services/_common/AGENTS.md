# @elizaos/cloud-services-common

Shared, dependency-free TypeScript utilities for Cloudflare Workers and the
`packages/cloud/services/*` sidecars: connector protocol, retry, delivery,
structured logging, and Kubernetes ServiceAccount helpers. Private
(unpublished), ESM, sources consumed directly from `src/` (no build step —
`main`/`types` point at `src/index.ts`).

## Layout / exports

- `src/index.ts` — barrel; re-exports everything below.
- `src/logger.ts` (`./logger`) — `createServiceLogger(serviceName, options?)`
  returns a `ServiceLogger` (`debug`/`info`/`warn`/`error`/`shouldLog`) that
  emits one JSON object per line. Level is gated by the `LOG_LEVEL` env var
  (`debug | info | warn | error`, default `info`), re-read on every call. Field
  order is selectable via `ServiceLoggerOptions.metaFirst`: default
  `{ timestamp, level, message, ...meta }`; `metaFirst: true` yields the
  agent-server shape `{ ...meta, timestamp, level, message }`.
- `src/k8s-service-account.ts` (`./k8s-service-account`) —
  `readServiceAccountToken()` and `readServiceAccountCaCert()` read the
  projected pod credentials under
  `/var/run/secrets/kubernetes.io/serviceaccount/`. Both return `null` when the
  files are absent (e.g. a developer laptop outside a cluster) and cache the
  first result. `__resetServiceAccountCacheForTests()` clears that cache for
  tests only.
- `src/k8s-deployment-wake.ts` (`./k8s-deployment-wake`) — performs a bounded
  Kubernetes Deployment scale PATCH and composes an optional caller abort
  signal with the operation deadline.
- `src/identity-link-code.ts` (`./identity-link-code`) — canonical connector
  LINK-code recognition and user-facing confirmation results.
- `src/gateway-auth.ts` (`./gateway-auth`) — strict short-lived gateway token
  response validation plus shared refresh and jittered retry timing.
- `src/response-attempts.ts` (`./response-attempts`) — bounded observable HTTP
  retry behavior shared across transport runtimes.
- `src/telegram-connector.ts` (`./telegram-connector`) — Web-standard Telegram
  webhook verification, parsing, typing, voice download, and reply delivery.
- `src/telegram-delivery.ts` (`./telegram-delivery`) — exact-once Telegram
  reply state machine over a runtime-provided atomic ledger.

## Key scripts

Scope to this package with `--cwd packages/cloud/services/_common`:

```bash
bun run --cwd packages/cloud/services/_common typecheck   # tsc --noEmit
bun run --cwd packages/cloud/services/_common lint         # biome check .
bun run --cwd packages/cloud/services/_common lint:fix     # biome check --write .
bun run --cwd packages/cloud/services/_common test         # delivery state-machine tests
```

## Conventions / gotchas

- The log output format is consumed by production log parsers — do not change
  the field set or ordering. Add structured context via the `meta` argument.
- `serviceName` is accepted by `createServiceLogger` for call-site convention
  but is not currently written into the log line.
- The k8s helpers cache on first successful read; in tests that toggle the
  cluster files, call `__resetServiceAccountCacheForTests()` between cases.
- This is the one place in cloud-services where `console.*` is intentional —
  it is the logger sink itself. Other cloud-services code should log through
  `createServiceLogger`, not `console`.
- No runtime dependencies; keep it that way so every service can import it
  cheaply.
- Keep provider protocol and delivery semantics runtime-neutral: Workers and
  Railway must delegate to the same source rather than maintaining forks.

Repo-wide rules (logger-only, ESM, naming, architecture) are in the root [CLAUDE.md](../../../../CLAUDE.md).

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
