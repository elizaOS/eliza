# @elizaos/corpus-tools

Private workspace package for the personal-corpus program (#14747/#14748). It
owns the canonical corpus JSONL schema, synthetic fixtures, validators, and
source-archive collectors consumed by later PII and LifeOps mock-loader work.

## Rules

- Raw, owner, or intermediate corpus data never enters git. Use the ignored
  `data/` tree; commit only synthetic fixtures under `fixtures/`.
- `src/schema.ts` is the boundary contract for collectors and scrub stages.
  Widen additively and update validators/tests with every schema change.
- Collectors are compatibility adapters, not schema owners. Keep
  platform-specific compromises (for example the X archive's same-shard
  reply-reference rule, or likes being counted but never fabricated into
  message rows) documented at the collector boundary.
- Validator failures are data errors; return structured diagnostics from the
  library and let only process boundaries translate them to exit codes.
- Collector output must be idempotent and resumable: re-running against the
  same input reuses byte-identical shards and rewrites only missing or changed
  ones.
- The loader (`src/loader.ts`) is the release gate for downstream consumers:
  its scrub floor defaults to `verified` and any shard validation issue aborts
  the load. Never add a consumer path that bypasses it to read shards
  directly.
- Reviewed deletion is two-phase and derived-output-only. Never mutate raw
  shards; bind every owner decision to the exact queue/rules/source hashes and
  keep review contents local while exposing only sanitized counts and digests.

Repo-wide rules and evidence standards are in the root `CLAUDE.md`.
