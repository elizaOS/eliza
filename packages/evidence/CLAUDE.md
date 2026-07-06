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

## Certification (#14546)

`src/certify/` turns a finalized bundle into a signed, offline-verifiable
promotion claim. Full flow:

1. **bundle** — `bundle:create` (or the orchestrator) finalizes
   `evidence/runs/<run-id>/`; `finalize()` returns `manifestSha256`.
2. **rollup** — `certify:rollup -- --bundle <dir> [--requirements <file>]`
   derives draft verdicts mechanically: lane `lanes/<lane>/result.json`
   counters (`failed>0` ⇒ fail; `skipped>0` ⇒ fail unless the requirements
   mark the lane optional-with-reason, then waived — honest-skip, #14506),
   `analysis.json` expectation failures (non-`pass` verdict or `ok:false`
   checks ⇒ fail), and required-artifact presence. Unparseable reporter
   output drafts as fail — a broken reporter is never a green lane.
3. **review** — an agent or human walks the draft + artifacts, edits the
   verdicts file. `waived` requires non-empty notes (schema-enforced).
4. **sign** — `certify:sign -- --bundle <dir> --verdicts <file>
   --reviewer-id <id> --reviewer-kind <agent|human>` refuses tampered
   bundles, builds the payload (bundleSha = sha256 of manifest bytes; commit/
   branch/tier from the integrity-bound `meta.json`), signs Ed25519 over
   `canonicalJsonBytes(payload-without-signature)`, writes
   `<bundle>/certification.json` (an envelope file, exempt from the
   unlisted-file sweep).
5. **verify** — `certify:verify -- --cert <file> --pubkey <pem>
   [--bundle <dir>] [--requirements <file>] [--expected-commit <sha>]
   [--max-age-hours N] [--required-tier T] [--json]` — the exact code the
   #14547 gate runs, fully offline. With `--bundle`, verification re-runs the
   mechanical rollup and fails if signed verdicts omit a rollup subject or mark
   a mechanically non-pass subject as `pass` (waive with notes instead). Exit 0
   iff valid; every failure is a distinct typed code (`schema-invalid |
   unsigned | bad-signature | wrong-key | stale | commit-mismatch |
   bundle-tampered | verdict-failures | verdict-incomplete |
   tier-insufficient`) and ALL detectable failures are reported together.

**Threat model.** A valid signature proves a holder of the private key
signed exactly these verdicts over exactly this bundle manifest for exactly
this commit — bundleSha binds the manifest, `metaSha256` binds provenance
transitively. It does NOT prove the review was diligent; the reviewer
identity `{kind, id, model?}` is in the signed payload for exactly that
reason. Certification parsing is strict: unknown top-level fields, unknown
verdict values, traversal/absolute evidence paths, and short commit shas are
all rejected — forward compat is a `schema` bump, never silent tolerance.

**Key custody.** Public key + trust model + rotation + break-glass:
`.github/certification/README.md`. The gate MUST read the public key from
the BASE branch (main), never the PR head. Private key ingress is
`ELIZA_CERT_SIGNING_KEY` (PEM or base64-wrapped PEM) or `--key-file` only;
nothing in this package writes a private key to disk or logs one —
`certify:keygen` prints it only under the explicit `--print-private-key`
flag.

## Commands

```bash
bun run --cwd packages/evidence test         # vitest suite
bun run --cwd packages/evidence typecheck    # tsgo --noEmit
bun run --cwd packages/evidence lint         # biome
bun run --cwd packages/evidence bundle:create -- --tier cpu
bun run --cwd packages/evidence bundle:verify -- evidence/runs/<run-id>
bun run --cwd packages/evidence certify:keygen -- [--print-private-key]
bun run --cwd packages/evidence certify:rollup -- --bundle <dir> [--requirements <file>] [--out <file>]
bun run --cwd packages/evidence certify:sign -- --bundle <dir> --verdicts <file> --reviewer-id <id> --reviewer-kind <agent|human>
bun run --cwd packages/evidence certify:verify -- --cert <file> --pubkey <pem> [--bundle <dir>] [--requirements <file>] [--json]
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
src/certify/
  schema.ts         strict certification contract + tier ordering
  keys.ts           Ed25519 keygen/fingerprint/ingress (never writes/logs keys)
  rollup.ts         mechanical draft verdicts (honest-skip semantics)
  sign.ts           signCertification / verifyCertification (typed failure codes)
  cli.ts            certify:keygen|rollup|sign|verify (J1 boundary)
```
