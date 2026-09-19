# Partitioned Knip audit

The canonical repository dead-code audit keeps one logical owner partition for
every workspace and runs its graph context in small, sequential Knip shards.
Each process has `NODE_OPTIONS=--max-old-space-size=4096`, so its V8 old-space
ceiling is 4096 MiB rather than the former repository-wide 16384 MiB ceiling.
Run the advisory inventory with:

```bash
bun run knip
```

Findings are reviewable but do not fail that command. Missing, duplicate,
malformed, non-zero, signalled, or out-of-memory partitions always fail it. Run
the same analysis with findings enforced by the aggregate command using:

```bash
bun run knip:strict
```

Strict mode does not pass Knip's dependency-focused `--strict` option; it keeps
the advisory analysis unchanged and makes a non-empty aggregate finding
inventory fail. This makes the two inventories directly comparable.

Reports are written under `reports/knip/`:

- `aggregate.json` is the deterministic sorted target/shard ledger, explicit
  completion status and failed/missing/duplicate/OOM outcomes, and complete
  finding inventory.
- `run.json` records mode, status, exact subprocess commands, configuration
  digests, elapsed time, exit codes, signals, stderr, and the configured memory
  ceiling.
- `workspaces/*.json` retains each owner shard's raw Knip report, graph context,
  and normalized owner-only findings.
- `configs/*.json` contains the exact effective configuration used for each
  workspace. It is composed from root global policy, the matching root
  `workspaces` override, and local `knip.json`; arrays are unioned without
  discarding public entrypoints or dynamic-use exceptions.

The target ledger is the union of the authoritative root package workspaces
and existing package directories named by root `knip.json#workspaces` entries.
The runner builds the workspace graph from both dependency declarations and
real TypeScript/JavaScript import, export-from, dynamic-import, and `require`
specifiers. Package-name and relative cross-workspace specifiers count in the
ledger. Relative and package-subpath imports keep their provider and consumer
in the same review context; package-root imports use the provider's preserved
public entrypoint configuration instead of re-analyzing every ordinary
consumer. Each owner is analyzed from the repository root alongside batches of
at most sixteen context dependents and 1,600 dependent source files (an
indivisible workspace may exceed the file limit alone). Provider dependencies are audited by their
own owner partitions and remain external resolution inputs in a consumer
partition instead of being recursively re-analyzed. Consumer-sensitive unused
categories (`files`, exports, types, enum members, and namespace variants)
survive only when every dependent batch
reports them, which prevents an externally consumed symbol from being
classified as unused. Context-positive findings such as cycles, dependency
problems, and unresolved imports are unioned so an observation from any shard
survives. Nested workspaces remain separate owners and are excluded unless
explicitly present in a shard's graph context. A nested owner with no private
cross-workspace consumers runs from its own package directory, preventing the
containing package's TypeScript graph from being loaded a second time. The
runner fails before execution if a nested owner needs consumer context that
cannot be preserved by that isolation.

When an owning package's `typecheck` script explicitly selects a project with
`-p` or `--project`, the shard passes that same checked-in tsconfig to Knip and
records it in the ledger. This prevents broad development-only path maps from
silently expanding a small workspace into the whole repository while keeping
the package's authoritative type-resolution contract.

This discovery includes concrete nested packages without hard-coding their
names, while retaining configuration for a temporarily absent workspace without
inventing a partition for it. Report paths are repository-relative and are
rejected unless they stay beneath `reports/` with no symlinked parent. An
exclusive `run.lock` prevents concurrent processes from interleaving canonical
reports; `run.json` starts incomplete and the previous aggregate is removed
before any shard executes.

The checked-in self-test uses the real runner with a fake Knip subprocess to
prove deterministic ordering and intersection, graph batching, nested exact
ownership, configuration composition, advisory versus strict behavior,
exclusive publication, and fail-closed handling. The same test also runs a
small real Knip producer/consumer fixture:

```bash
node --test "$PWD/packages/scripts/knip-partitioned.test.mjs"
```
