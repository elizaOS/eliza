# @elizaos/corpus-tools

Private workspace package for the personal-corpus program (#14747/#14748). It
owns the canonical corpus JSONL schema, synthetic fixtures, validators, and
mock-shape mappers consumed by later collector, PII, and LifeOps mock-loader
work.

The iMessage collector in `src/collectors/imessage.ts` uses the public
`@elizaos/plugin-imessage` strict backfill reader. It creates a transactionally
consistent local snapshot, hashes attachment bytes without embedding them, and
publishes monthly account shards plus a privacy-safe structural report under
the output root's `.reports/` directory. A process-lifetime advisory lock
serializes all accounts, while a durable journal restores or completes an
interrupted shard, manifest, and report transaction on the next run.

## Rules

- Raw, owner, or intermediate corpus data never enters git. Use ignored
  `data/`; commit only synthetic fixtures under `fixtures/`.
- `src/schema.ts` is the boundary contract for collectors and scrub stages.
  Widen additively and update validators/tests with every schema change.
- Mappers are compatibility adapters, not schema owners. Keep platform-specific
  compromises, such as X-to-generic-channel mapping, documented at the mapper
  boundary.
- Validator failures are data errors; return structured diagnostics from the
  library and let only the CLI translate them to stdout/stderr and exit codes.
- Collectors replace deterministic account shards atomically. Source databases,
  snapshots, attachment paths, report HMAC keys, and raw identifiers remain in
  ignored private state; missing or changing attachment bytes fail the run.
- Verification is corpus-wide, non-mutating, and fail-closed. A row-level stage
  may not assign `scrubState: "verified"`; publication reruns the complete gate
  against every bound input, and its declared scope must not imply multimodal
  coverage.
- Raw gitleaks output, mine candidates, gazetteers, and other cleartext
  provenance stay local. Persisted verification findings contain hashes and
  structural locations only.
- Verification and publisher freshness checks bind the exact manifest, ledger,
  mine candidates, gazetteer, deletion rules/review/approval chain, placeholder
  registry, scanner config, and final corpus bytes. Report self-hashes detect
  corruption but never substitute for a fresh rerun or owner authorization.

Repo-wide rules and evidence standards are in the root `AGENTS.md`.

## Collector command

```bash
bun run --cwd packages/corpus-tools corpus:collect:imessage -- \
  --output <ignored-corpus-dir> --state-dir <ignored-state-dir> \
  --account-id <slug> --owner-id <id> --owner-display <name>
```

The default source is `~/Library/Messages/chat.db`; the host terminal requires
macOS Full Disk Access. The canonical collection window is 2024-07-05 through
2026-07-05 (exclusive upper bound).
