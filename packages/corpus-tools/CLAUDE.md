# @elizaos/corpus-tools

Private workspace package for the personal-corpus program (#14747/#14748). It
owns the canonical corpus JSONL schema, synthetic fixtures, validators, and
mock-shape mappers consumed by later collector, PII, and LifeOps mock-loader
work.

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
