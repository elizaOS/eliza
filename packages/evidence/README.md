# @elizaos/evidence

Evidence-bundle foundation for the unified evidence harness and develop→main
certification pipeline (epic #14541). The maintained architecture and
certification contract live in this README and the package `CLAUDE.md`.

One harness run produces one bundle: `evidence/runs/<run-id>/` with a
`manifest.json` listing every artifact and a `meta.json` recording provenance
(commit, branch, runner, tier, env fingerprint). Named ingestors copy
each producer's canonical output into the bundle and stamp provenance at ingest
time. The reviewer never crawls those producer directories on its normal path;
it verifies and reads the bundle manifest. Certification (#14546) signs
sha256(manifest bytes), which is why the manifest is written in a canonical,
byte-stable form.

The run ID is one normalized path leaf. Bundle creation claims that directory
atomically and refuses existing directories or aliases; a caller-supplied run
ID cannot traverse outside the configured bundle root.

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

interface BundleManifest {
  schema: 1; runId: string; createdAt: string;
  metaSha256: string;  // sha256 of meta.json bytes — binds provenance into the signed envelope
  artifacts: ArtifactEntry[];
}

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
sorted, no whitespace, UTF-8, one trailing newline. Non-plain objects
(Date/Map/Set/class instances) throw rather than silently serializing as
`{}`; `toJSON` is not honored — callers pre-serialize. See `src/canonical.ts`.

Bundle paths are NFC-normalized at `addArtifact` ingress so macOS (NFD) and
linux (NFC) produce identical manifest bytes for the same logical filename.
`finalize()` writes and hashes `meta.json` first, then embeds that hash as
`manifest.metaSha256` — forged provenance fails verification.

## Ingestors

Pure discovery + copy. Each named silo reports honestly:
`absent` (no root exists) is a different result from `ingested` with zero
artifacts (root exists but is empty).

| silo | roots | lane |
| --- | --- | --- |
| `e2e-recordings` | `e2e-recordings/` | e2e |
| `aesthetic-audit` | `packages/app/aesthetic-audit-output/` | — |
| `device-e2e` | `packages/app/device-e2e-output/` | native |
| `playwright-test-results` | `packages/app/test-results/` | e2e |
| `ios-device-capture` | `packages/app/ios/build/boot-capture/`, `packages/app/ios/build/device-logs/` | native |
| `walkthrough-reports` | `reports/walkthrough/` | — |
| `live-test-runs` | `reports/live-test-runs/` | — |
| `scenario-runner` | `reports/scenarios/` | scenario |

The former roots `device-e2e-output/`,
`packages/app/reports/walkthrough/`, and
`packages/scenario-runner/reports/` have no live writer and are not part of
normal ingestion. Operators inspecting archived material may pass them to the
reviewer with explicit `--source`; that compatibility mode never runs
implicitly. Artifacts are copied into the bundle and hashed **as stored** so
later producer writes cannot mutate a finalized run and a corrupt copy fails at
add time.

## CLI

```bash
bun run --cwd packages/evidence bundle:create -- --tier cpu [--out evidence/runs] [--repo-root <dir>]
bun run --cwd packages/evidence bundle:snapshot -- --repo-root <dir> --out <snapshot.json>
bun run --cwd packages/evidence bundle:create -- --tier cpu --baseline <snapshot.json>
bun run --cwd packages/evidence bundle:verify -- evidence/runs/<run-id>
bun run evidence:review:no-open -- --bundle=evidence/runs/<run-id>
```

`create` collects git provenance (fails loud outside a repo), resolves the
runner (`ELIZA_EVIDENCE_RUNNER` ∈ local|vast|ci, else `CI` env, else local),
ingests every silo plus explicit `--lane-report <lane>=<json-file>` inputs,
finalizes, and prints a per-silo summary plus the manifest sha256. `verify`
re-hashes every artifact and reports `missing` /
`size-mismatch` / `hash-mismatch` / `unlisted` / `symlink` / `meta-mismatch`
findings; non-zero exit on any issue. Verification is lstat-based: a verified
bundle contains no symlinks or multiply-linked files anywhere — either could
remain mutable through an external alias after signing, while a symlinked
directory could mount an unswept external tree. Artifact sources are opened
without following links, copied through a stable descriptor, and rejected if
their identity changes during the copy.

The coordinated matrix captures a content-and-filesystem-identity snapshot
before its lanes run and passes it through `--baseline`; untouched files in
persistent producer roots are excluded, while files written or replaced during
the run are included even when their resulting bytes equal the prior bytes.

## How later pieces slot in

- **Analyzers (#14542):** consume `manifest.json`, write
  `analysis.json` fragments back via `addArtifact` with `bundlePath` beside
  the analyzed artifact (`kind: 'analysis'`).
- **VLM Q&A (#14544):** same pattern, `kind: 'qa'`, `qa.json` beside pixels.
- **Certify (#14546):** runs the matrix, ingests, calls `verifyBundle`, signs
  `FinalizeResult.manifestSha256`, writes `certification.json` (an envelope
  file, exempt from the unlisted-file sweep). Draft rollup output stays outside
  the finalized bundle and cannot replace its manifest, metadata, artifacts, or
  reserved certification envelope.
- **CI gate (#14547):** verifies the signature against the committed public
  key and re-runs `verifyBundle` when the bundle is available.

## Development

```bash
bun run --cwd packages/evidence test        # vitest, real tmp-dir filesystem
bun run --cwd packages/evidence typecheck
bun run --cwd packages/evidence lint
```
