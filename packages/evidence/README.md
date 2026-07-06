# @elizaos/evidence

Evidence-bundle foundation for the unified evidence harness and develop→main
certification pipeline (epic #14541, design doc:
`packages/docs/ongoing-development/unified-evidence-harness.md`).

One harness run produces one bundle: `evidence/runs/<run-id>/` with a
`manifest.json` listing every artifact and a `meta.json` recording provenance
(commit, branch, runner, tier, env fingerprint). Existing evidence producers
are **not rewritten** — ingestors copy/hardlink their output into the bundle
and stamp provenance at ingest time. Certification (#14546) signs
sha256(manifest bytes), which is why the manifest is written in a canonical,
byte-stable form.

## Schema contract (frozen, `schema: 1`)

```ts
type ArtifactKind = 'screenshot'|'video'|'keyframe'|'log'|'trajectory'
                  | 'report'|'analysis'|'qa'|'html-tree'|'other';
type RunnerKind   = 'local'|'vast'|'ci';
type Tier         = 'cpu'|'gpu'|'full';

interface ArtifactEntry {
  path: string;        // bundle-relative posix; `..`/absolute/backslash rejected
  sha256: string;      // lowercase hex, hashed as stored in the bundle
  bytes: number;
  kind: ArtifactKind;
  source: string;      // producer id, e.g. 'aesthetic-audit'
  lane?: string;       // e2e | scenario | native | …, when known
  producedBy: string;  // tool/script that produced the artifact
  createdAt: string;   // ISO-8601
}

interface BundleManifest { schema: 1; runId: string; createdAt: string; artifacts: ArtifactEntry[] }

interface BundleMeta {
  schema: 1; runId: string; commit: string; branch: string;
  runner: RunnerKind; tier: Tier; startedAt: string; finishedAt?: string;
  envFingerprint: Record<string, string>;   // small allowlist, never full env
  timings?: Record<string, number>;         // milliseconds per phase
}
```

Later harness pieces (analyzers #14542, VLM Q&A #14544, certify #14546) build
against these exact names and semantics. Widen only additively under a schema
version bump. Reading a manifest/meta from disk goes through `parseManifest` /
`parseMeta`, which throw `EvidenceValidationError` with per-field issues —
never a silently-repaired object.

## Bundle layout

`runId` is `<utc yyyymmdd-hhmmss>-<shortsha>-<tier>`. Default placement is a
deterministic kind→family mapping; `bundlePath` overrides it for exact
placement (analyzers writing `analysis.json` beside pixels):

```
evidence/runs/<run-id>/
  manifest.json  meta.json  certification.json (certifier-only, later)
  lanes/<lane>/…            report kind (logs under lanes/<lane>/logs/…)
  trajectories/<source>/…   trajectory kind
  visual/<source>/…         screenshot kind
  video/<source>/…          video kind (keyframes under video/<source>/keyframes/…)
  html-trees/…              html-tree kind
  misc/<source>/…           analysis / qa / other, and lane-less logs/reports
```

Manifest canonicalization (hard requirement — certification signs these
bytes): artifacts sorted by `path` (UTF-16 code-unit order), object keys
sorted, no whitespace, UTF-8, one trailing newline. See `src/canonical.ts`.

## Ingestors

Pure discovery + copy; producers untouched. Each silo reports honestly:
`absent` (no root exists) is a different result from `ingested` with zero
artifacts (root exists but is empty).

| silo | roots | lane |
| --- | --- | --- |
| `e2e-recordings` | `e2e-recordings/` | e2e |
| `aesthetic-audit` | `packages/app/aesthetic-audit-output/` | — |
| `device-e2e` | `device-e2e-output/`, `packages/app/device-e2e-output/` | native |
| `playwright-test-results` | `packages/app/test-results/` | e2e |
| `walkthrough-reports` | `reports/walkthrough/`, `packages/app/reports/walkthrough/` | — |
| `live-test-runs` | `reports/live-test-runs/` | — |
| `scenario-runner` | `packages/scenario-runner/reports/`, `reports/scenarios/` | scenario |

Multi-root silos namespace bundle paths by a per-root label so roots cannot
collide. Artifacts are hardlinked when the silo shares a volume with the
bundle, copied otherwise, and hashed **as stored** so a corrupt copy fails at
add time.

## CLI

```bash
bun run --cwd packages/evidence bundle:create -- --tier cpu [--out evidence/runs] [--repo-root <dir>]
bun run --cwd packages/evidence bundle:verify -- evidence/runs/<run-id>
```

`create` collects git provenance (fails loud outside a repo), resolves the
runner (`ELIZA_EVIDENCE_RUNNER` ∈ local|vast|ci, else `CI` env, else local),
ingests every silo, finalizes, and prints a per-silo summary plus the manifest
sha256. `verify` re-hashes every artifact and reports `missing` /
`size-mismatch` / `hash-mismatch` / `unlisted` findings; non-zero exit on any
issue.

## How later pieces slot in

- **Analyzers (#14542):** consume `manifest.json`, write
  `analysis.json` fragments back via `addArtifact` with `bundlePath` beside
  the analyzed artifact (`kind: 'analysis'`).
- **VLM Q&A (#14544):** same pattern, `kind: 'qa'`, `qa.json` beside pixels.
- **Certify (#14546):** runs the matrix, ingests, calls `verifyBundle`, signs
  `FinalizeResult.manifestSha256`, writes `certification.json` (an envelope
  file, exempt from the unlisted-file sweep).
- **CI gate (#14547):** verifies the signature against the committed public
  key and re-runs `verifyBundle` when the bundle is available.

## Development

```bash
bun run --cwd packages/evidence test        # vitest, real tmp-dir filesystem
bun run --cwd packages/evidence typecheck
bun run --cwd packages/evidence lint
```
