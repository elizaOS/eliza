# @elizaos/evidence — agent guide

Evidence-bundle foundation for the unified evidence harness (epic #14541,
issue #14552). Read `README.md` for the schema contract, bundle layout, silo
table, and CLI; read the design doc at
`packages/docs/ongoing-development/unified-evidence-harness.md` for how the
whole pipeline (analyzers → VLM Q&A → certify → CI gate) fits together.

## Hard rules

- **`src/schema.ts` is a frozen contract.** `ArtifactEntry`, `BundleManifest`,
  `BundleMeta`, and the `ArtifactKind`/`RunnerKind`/`Tier` unions are what
  #14542/#14544/#14546 build against. Widen only additively, and only under a
  `schema` version bump. The zod validators are held mutually assignable with
  the interfaces at compile time — keep that guard intact.
- **Manifest bytes are signed.** `finalize()` must stay byte-stable: artifacts
  sorted by path, canonical JSON (sorted keys, no whitespace, one trailing
  newline — `src/canonical.ts`; non-plain objects throw, `toJSON` is not
  honored), bundle paths NFC-normalized at ingress. Any change to
  serialization is a certification-breaking change.
- **Provenance is bound.** `finalize()` writes + hashes `meta.json` before
  building the manifest and embeds `metaSha256`; `verifyBundle` re-checks it
  (`meta-mismatch`). A verified bundle contains no symlinks anywhere —
  verification is lstat-based and reports `symlink` findings instead of
  following links (mutable-after-signing / unswept-tree exploits).
- **Producers are not touched.** Ingestors (`src/ingest.ts`) only discover and
  copy. `packages/app/scripts/**` and `scripts/evidence-review/**` are hot
  zones with in-flight PRs; this package deliberately lives outside them.
- **Absent ≠ empty.** An ingestor returns `status: 'absent'` when no silo root
  exists and `status: 'ingested'` with `artifactCount: 0` when a root exists
  but is empty. Never conflate them and never fabricate an empty success.
- **Fail fast, typed.** Throw `EvidenceError`/`EvidenceValidationError`
  (mirrors core's `ElizaError` shape without depending on the framework —
  this package must run in minimal CI/vast containers). No `?? <default>` for
  failed/missing data. The library never logs; the CLI is the only output
  boundary.
- **Tests are real.** Vitest against real tmp-dir filesystems and real
  `git init` repos; the only injected seams are the clock (byte-stability)
  and the link function (EXDEV cannot be created portably in one tmp volume).

## Commands

```bash
bun run --cwd packages/evidence test         # vitest suite
bun run --cwd packages/evidence typecheck    # tsgo --noEmit
bun run --cwd packages/evidence lint         # biome
bun run --cwd packages/evidence bundle:create -- --tier cpu
bun run --cwd packages/evidence bundle:verify -- evidence/runs/<run-id>
```

Test-lane membership is declared via `elizaos.scripts.testLanes: ["server"]`
in `package.json` (discovered by `packages/scripts/run-all-tests.mjs`).

## Layout

```
src/schema.ts       frozen schema-1 types + zod validation (J3 typed invalid)
src/canonical.ts    canonical JSON bytes (signed form)
src/bundle.ts       EvidenceBundle builder + verifyBundle integrity report
src/provenance.ts   git facts (fail loud), runner kind, env fingerprint allowlist
src/ingest.ts       silo definitions + ingestAllSilos / ingestNamedSilo
src/cli.ts          thin argv/formatting layer over the lib (J1 boundary)
src/errors.ts       EvidenceError / EvidenceValidationError
```
