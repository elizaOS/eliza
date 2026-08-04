# @elizaos/cloud-services-common

Shared, dependency-free TypeScript utilities for the `packages/cloud/services/*`
packages: a structured JSON logger factory and Kubernetes ServiceAccount
credential helpers. Private (unpublished), ESM, sources consumed directly from
`src/` (no build step — `main`/`types` point at `src/index.ts`).

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

## Key scripts

Scope to this package with `--cwd packages/cloud/services/_common`:

```bash
bun run --cwd packages/cloud/services/_common typecheck   # tsc --noEmit
bun run --cwd packages/cloud/services/_common lint         # biome check .
bun run --cwd packages/cloud/services/_common lint:fix     # biome check --write .
bun run --cwd packages/cloud/services/_common test         # placeholder: prints "no tests"
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

Repo-wide rules (logger-only, ESM, naming, architecture) are in the root [CLAUDE.md](../../../../CLAUDE.md).

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
