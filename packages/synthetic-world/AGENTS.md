# `@elizaos/synthetic-world`

This private package owns the versioned, deterministic synthetic-world contract
shared by scenario-runner, plugin integration tests, local development, and
Cloud E2E. Repository-wide engineering and evidence requirements are inherited
from the root [`CLAUDE.md`](../../CLAUDE.md).

## Ownership boundary

The package owns manifests, canonical hashing, virtual-time injection, named
fault scripts, observation ledgers, lifecycle/reset semantics, and worker
namespaces. It does not own production schedulers, queues, provider clients, or
storage repositories. Consumers inject its clock and boundary adapters into the
real production implementations.

The manifest is data, not executable setup. Add domain objects or provider
fixtures to the versioned schema and keep scenario overlays declarative.

## Safety and determinism

- Fixtures must contain only reserved example domains, synthetic phone numbers,
  and obvious non-secret tokens.
- State hashes are computed from canonical JSON and must reproduce across
  processes.
- Reset and restore clear every observation ledger.
- Virtual time must never depend on wall-clock sleeps.
- Parallel consumers must allocate a worker namespace and never share a
  `SyntheticWorld` instance.

## Commands

```bash
bun run --cwd packages/synthetic-world test
bun run --cwd packages/synthetic-world typecheck
bun run --cwd packages/synthetic-world lint:check
```
