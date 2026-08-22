# Parallel execution goal: progressive content access

Use this file as the `/goal` brief for implementation.

```text
/goal Implement the progressive content access architecture specified in
docs/design/context-content/progressive-content-access-spec.md, using the current-system,
external-system, corpus, testing, performance, and rollout findings in
docs/design/context-content/progressive-content-access-research-and-test-report.md.

Outcome:
elizaOS can inspect authorized content larger than prompt limits—bounded by
explicit source, retention, storage, and safety limits—including files, tool outputs, documents,
email bodies, attachments, and large memory fields through bounded, exact,
model-aware views without irreversible prompt truncation. The complete source
remains addressable under existing retention and authorization policies;
continuation survives compaction; final serialization stays within budget; and
real agent behavior, isolation, security, latency, memory, and cleanup are proven.

Execution rules:
- Read the root guide, CONTRIBUTING.md, and every owning package CLAUDE.md/README.
- Start with a live truncation inventory and exact current origin/develop SHA.
- Open/link the required issue before non-trivial implementation work.
- Use isolated worktrees/branches for independent lanes; never overwrite the
  shared dirty checkout or another lane's files.
- The coordinating agent owns public contracts, integration order, rebases,
  conflict resolution, final validation, evidence review, and PR state.
- Do not add a second attachment/media byte store or a fileId to Media. Do not claim the
  current pre-auth/FIFO media store is durable private tool-output storage.
- Keep established FILE/DOCUMENT/ATTACHMENT/email/SHELL actions in v1. Share a
  small ReadSlice envelope; defer a generic CONTENT action/global URI.
- Do not raise fixed caps as the solution. A bounded projection must include a
  resolvable model-safe reference, exact range, revision, completeness, and continuation.
- Do not put full bodies in ActionResult.data when promptData/content views exist.
- Preserve existing fail-closed transport, security, and database limits.
- Every behavioral acceptance test must execute production code and kill its
  assigned architectural mutant.
- Completion means exact-head local gates, hosted CI, generated evidence, and
  inspected real artifacts/trajectories at the same revision.

Dispatch parallel research/implementation lanes:

1. Core contract and prompt projection
   - Own ReadSlice/expected-revision contracts, token-aware per-result and
     aggregate budgeting, ActionResult integration, and non-duplicating planner
     serialization.
   - Add unit, seeded property, hostile-shape, and conformance tests.
   - Keep the contract additive and source-neutral.

2. Private tool-result lifecycle research and contract tests
   - Reuse the content-addressed byte layer and existing terminal/background-
     shell patterns without exposing sensitive results through public media URLs.
   - Specify authorization, retention, reference-aware GC, atomic publication,
     redaction, provenance, deduplication, and typed failure before enabling spill.
   - Prove the proposed lifecycle with contract/fault tests. Do not enable spill
     until the coordinator approves authorization, retention, and GC.

3. File and coding-tool adapter
   - Replace whole-file/256 KiB rejection with bounded line/byte I/O and safe decoding.
   - Add stable offset/revision handling, huge-single-line support, mutation,
     symlink/sandbox, binary, cancellation, and background-process cases.
   - Measure bytes read and peak RSS against source size.

4. Document, email, and stored-attachment adapters
   - Reuse authorized document fragments, connector body fetches, existing
     attachment disclosure/media metadata, and room/world authorization.
   - Implement document-fragment, stored-attachment-text, and email-body paging
     with fair previews, revocation, and no full-body duplication.
   - Keep classifier/triage previews intentionally small and later-readable.

5. Scenario corpus and agent-behavior proof
   - Build deterministic generators/manifests with planted canaries across
     sizes, boundaries, encodings, late evidence, decoys, multiple items, and
     adversarial pages.
   - Extend scenario seeds/final checks for references, ranges, search, compaction,
     stale revisions, authorization, budgets, and exact canary provenance.
   - Harden and use per-process scenario isolation; add scheduled live-model
     trajectories across representative model/context sizes.
   - Own the versioned manifest, deterministic seed/ID/time/archive metadata,
     concrete scale profiles, reassembly/search/ACL oracles, and format matrix.

6. Performance, soak, UI/E2E, and evidence
   - Add child-process benchmarks for cold/warm p50/p95/p99 latency, TTFT/time to
     evidence, source bytes read, serialized tokens, RSS/heap/external memory,
     descriptors, storage growth, cleanup, and cost.
   - Record throughput, concurrency/queue latency, CPU/event-loop/GC, array
     buffers, DB query/row/index work, filesystem I/O, prompt amplification,
     and cache invalidation correctness.
   - Exercise real upload/email/document/tool flows and the context inspector
     through existing Playwright/app audit/recording paths.
   - Ingest benchmark JSON, scenario reports, trajectories, logs, screenshots,
     and videos through the canonical evidence bundle.

Milestones and merge order:
M0 inventory + issue + frozen contracts/fixtures.
M1 ReadSlice/projection/telemetry behind a feature flag.
M2 bounded file adapter + conformance/performance gates.
M3 document/attachment/email native paging.
M4 aggregate projection + compaction reference/range manifest.
M5 private tool-output lifecycle/spill, only after its storage contract is approved.
M6 destructive-cap migration, live-model tuning, soak, evidence, rollout.

Required generated corpus:
- Boundary sizes: empty and -1/exact/+1 around 4K, 10K, 32K, 50 KiB,
  128 KiB, 256 KiB, and final serialized token budgets; plus 1 MiB and 10 MiB.
- Lines: normal, CRLF, no final newline, 100 KiB and multi-MiB single lines,
  minified/escaped JSON.
- Unicode: CJK, RTL, combining, emoji/ZWJ, invalid input boundaries.
- PDFs/docs/sheets: early/middle/last-page facts, OCR, tables, headings.
- Email/MIME: long alternatives, quoted history, threads, many attachments,
  encoded headers, revoked scopes.
- Memories: large room-scoped sets, cross-room decoys, conflicts, compaction.
- Tool output: stdout/stderr, binary, progress rewrites, capture overflow,
  restart, failure tails.
- Canaries at beginning/boundary/middle/end with checksums and exact coordinates.

Non-negotiable acceptance:
- No gaps, duplicates, malformed Unicode, or silent completeness claims.
- Small pages do not materialize source-sized memory or I/O.
- Stale/tampered continuation state and revoked access fail explicitly.
- Full traversal SHA matches the authoritative source and sequential paging is
  linear rather than quadratic.
- Unauthorized bytes are absent from prompt, log, trajectory, cache, and
  inspector surfaces.
- Late evidence is found in every source family; multiple items are fair.
- Model-safe references/ranges remain readable after compaction when authorized.
- Prompt tokens stay inside the computed post-serialization budget.
- Source text is not duplicated through planner data.
- Deterministic scenarios assert tool calls/ranges and final canaries.
- Live scenarios prove models discover continuation without answer leakage.
- Isolation, restart, retention, cleanup, and security faults are covered.
- Exact-head package tests, typecheck, lint, root verify, evidence integrity,
  hosted CI, and human inspection of outputs all pass.
- Real Postgres nightly/release lanes pass, and every metric report records the
  corpus manifest/generator revision, commit, machine, sample count, warm/cold
  state, and concurrency.
- The explicit architectural mutant catalog has a 100% kill rate.

CI/evidence mapping:
- Focused core, agent integration, coding-tools, scenario-runner, evidence, and
  affected connector/document tests run on every relevant PR.
- PR runs the keyless deterministic corpus in isolated child processes;
  post-merge runs larger real-stack/restart coverage; scheduled lanes run live,
  provider-qualified, soak, and performance matrices.
- App-visible work runs real local-stack Playwright E2E and `audit:app`, capturing
  backend logs, browser console/network, DB/artifact rows, screenshots, and video.
- Add content paths to the CI path gate, then run `bun run verify`,
  `bun run test:matrix`, canonical bundle review, and integrity verification.

Primary validation commands:
- `bun run --cwd packages/core test`
- `bun run --cwd packages/agent test`
- `bun run --cwd packages/agent test:integration`
- `bun run --cwd plugins/plugin-coding-tools test`
- `bun run --cwd packages/scenario-runner test`
- `bun run --cwd packages/evidence test`
- `bun run --cwd packages/app test:e2e` and `bun run --cwd packages/app audit:app`
- `bun run verify` and `bun run test:matrix`

At each milestone, report: changed contract, tests and corpus cases added,
performance distribution versus baseline, memory/storage behavior, failures,
evidence bundle path, exact SHA, and remaining risks. Stop and ask for direction
only for a genuine product-policy choice, credentials/MFA, external billing,
provider activation, or authority beyond the linked issue.
```

## Coordinator checklist

- Assign non-overlapping file ownership before mutations begin.
- Require each lane to return exact file references, commands, results, corpus seeds, metric JSON, and known gaps.
- Review contracts centrally before adapters depend on them.
- Run integration and scenario lanes after every contract milestone, not only at the end.
- Re-query the open PR/issue inventory before final disposition of truncation PRs.
- Do not call the goal complete while implementation, hosted checks, live-model proof, UI evidence, or performance baselines remain outstanding.
