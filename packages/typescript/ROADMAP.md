# Roadmap — `@elizaos/core`

Forward-looking work and **rationale** for changes we have not made yet. Shipped behavior, including **why** it landed, lives in [CHANGELOG.md](./CHANGELOG.md). Subsystem-specific intent is in [docs/DESIGN.md](./docs/DESIGN.md); queue/drain composition is in [docs/BATCH_QUEUE.md](./docs/BATCH_QUEUE.md).

---

## Robustness and runtime UX

- **Configurable provider timeout** — `composeState` uses a fixed per-provider timeout today so defaults stay predictable. Making it configurable (per agent or per provider) is deferred.
  - **Why wait:** avoids a matrix of timeouts across plugins before we have concrete operator demand and tests.
- **Circuit breaker or backoff for providers** — repeated failures still invoke failing providers each turn.
  - **Why it matters:** reduces retry storms and noisy logs when an integration is down; needs clear semantics so we do not hide failures silently.

## API and typing consistency

- Continue aligning adapter and runtime types (see CHANGELOG for recent `Promise<boolean>` batch mutations, etc.).
  - **Why:** keeps `tsc` and plugin authors aligned with one contract.

## Observability

- Expand structured logging where operators routinely debug (tasks, batcher drains, embedding queue depth) without spamming default logs.
  - **Why:** production triage should not require reproducing locally.

---

When you ship a roadmap item, add a **CHANGELOG** entry with a **Why** bullet (see existing Unreleased style) and update or remove the item here so this file stays honest.
