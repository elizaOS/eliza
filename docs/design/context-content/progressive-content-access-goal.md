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
real agent behavior, bounded source work, isolation, security, latency, memory,
database cost, and cleanup are proven.

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
- Classify continuations as restart-safe, session-safe, or non-resumable. Only
  refs with a direct fresh-process durable resolver may enter persisted manifests.
- Use one deterministic source/oracle corpus plus one native-realization ledger,
  one parametrized adapter conformance suite, one threshold policy, one result
  schema, and one evidence coordinator. Do not fork these per adapter.
- A bounded response is not acceptance when the adapter still fetches, scans,
  hashes, decodes, or allocates the complete source on every page.
- Canonical continuity is logically complete. Bound each storage record and the
  model projection, but roll overflow into ordered authorized addressable shards;
  omission counters may describe projection only and never replace durable entries.
- Completion means exact-head local gates, hosted CI, generated evidence, and
  inspected real artifacts/trajectories at the same revision.

Historical baseline ownership map (reference only; do not dispatch these as current lanes):

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

Current parallel dispatch uses only these four non-overlapping lanes. Individual
focused tests run within each lane, but do not start the integrated verification
wave until A-D return and the coordinator completes shared-file integration.
No parallel lane edits `packages/core/src/services/message.ts`; the coordinator
integrates its summary-persistence, source-reader, and final-projection call sites
sequentially after A, C, and D return. The coordinator also resolves shared type,
export, fixture-ratchet, and registry-manifest changes.

A. Lossless continuity and restart
   - Exclusive ownership: `packages/core/src/features/advanced-memory/` summary
     manifest/persistence/provider files, `packages/core/src/runtime/content-access-manifest*`,
     `packages/core/src/types/content-manifest*`, and corresponding advanced-memory
     storage contract/tests in core and plugin-sql. Do not edit `services/message.ts`.
   - Replace lossy count/byte eviction with ordered restart-safe manifest shards
     in the existing memory/database domain. Recover every ordered entry/range
     after count rollover, byte rollover, repeated rollover, and serialization pressure.
   - Kill mutants that replace shards with omission counters or break, skip,
     repeat, reorder, or loop next-links. A owns these mutant implementations and
     killing tests; B owns only the shared registry schema/harness.
   - Deliver writer/reader child-process storage/provider harnesses over PGLite.
     After shared-file integration, the coordinator runs production summary/action
     traversal and the same semantic vectors on Postgres.

B. Native corpus realization and conformance
   - Exclusive ownership: `packages/corpus-tools/src/progressive-content-*`, a
     shared conformance harness under `packages/core/src/testing/`, the checked-in
     mutant registry schema/runner, and content-context threshold/result schemas.
   - Consume corpus v2 and seed real memory/document/media/Gmail/tool-output
     services. Emit a verified object-to-native-reference/revision/scope/cleanup ledger.
   - Build one adapter factory/harness covering read, revision, authorization,
     reassembly, source-work counters, faults, concurrency, restart, and cleanup.
   - Provide named sub-artifacts to `test:matrix:review`; do not own bundle creation,
     ingestion, verification, or review.

C. Bounded native adapters
   - Exclusive ownership: document, stored-memory reader, attachment, and email
     action/service/storage files, excluding advanced-memory files owned by A and
     excluding `packages/core/src/services/message.ts`.
   - Store large document/message/attachment/email text as immutable,
     non-overlapping indexed UTF-8 segments with precomputed revisions.
   - Return typed reindex-required for legacy unsegmented large content; never
     hide repeated parent scans, hashes, provider refetches, or source-sized
     allocation behind a small page.
   - Implement owner-bound attachment locators and stable connector body revisions;
     reauthorize every continuation and cached read.

D. Final-wire projection and private-artifact contract
   - Exclusive ownership: provider request preparation/model-budget code and agent
     terminal/private-artifact lifecycle files. Do not edit source adapters, corpus,
     advanced-memory files, or `packages/core/src/services/message.ts`.
   - Project after provider request preparation with tokenizer/model-aware counts,
     reserves, rerendering, and provider-token reconciliation.
   - Add private tool-result spill only after owner scope, leases, expiry, atomic
     publication, redaction, reference-aware GC, and failure semantics pass.

Integrated verification wave after A-D return and coordinator shared-file integration:
- Scenario/evidence/app/CI owners consume, but do not redefine, the shared corpus,
  conformance, mutant, threshold, and shard contracts.
- Add strict-fixture planning with no offsets/canaries in prompts, provider-qualified
  repetitions, inspector E2E, the complete fault/concurrency matrix, Postgres,
  and the six-hour plus 100K-operation soak.
- Add `packages/scripts/run-content-context.mjs` as a named completeness-enforcing
  producer invoked by `test:matrix:review`; the matrix command remains the sole
  bundle inventory/execution/creation/verification/review authority.

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
- Count/byte pressure never deletes canonical references or ranges; a bounded
  projection exposes an authorized continuation through every persisted shard.
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
- A selected credentialed lane fails when credentials are absent; optional
  discovery skips never satisfy acceptance.
- The content-context named producer requires every declared sub-artifact;
  `test:matrix:review` inventories producers, creates the exact bundle, verifies
  and reviews it, and records the exact revision.

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
