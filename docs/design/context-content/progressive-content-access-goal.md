# Parallel execution goal: progressive content access and prompt integrity

Use this file as the `/goal` brief for implementation.

```text
/goal Complete and merge the progressive content access and prompt-integrity
architecture specified in
docs/design/context-content/progressive-content-access-spec.md, using the current
system audit, external research, corpus, test, performance, and rollout findings in
docs/design/context-content/progressive-content-access-research-and-test-report.md.

Outcome:
elizaOS reads large authorized files, tool output, documents, email bodies,
attachments, and memory fields through explicit bounded native pages with exact
ranges, revision-bound continuation, and source-size-independent work. Once content
is selected for a model call, prompt, action/tool results, conversation history,
evaluator input, provider output, model output, and training rows remain complete.
The exact final serialized request is dispatched unchanged only when it fits the
selected provider/model boundary; otherwise a typed actionable error is returned
before any provider call. Durable navigation uses a content-free head and immutable
bounded shards, is never injected automatically into summaries/model context, and
is read only through an explicit authorized operation.

Current status to preserve:
- #24305, #24345, #24521, and #24496 are merged.
- #24498 and #24387 are closed and their rejected continuity shapes must not be
  revived.
- #24592 is active for complete final-wire serialization and typed rejection.
- Truly bounded native DOCUMENT reads and durable continuity are active.
- Native realization, full mutants/faults/scenarios/E2E/Postgres/performance/soak,
  hosted CI, and final truncation inventory remain required.

Execution rules:
- Read root AGENTS.md/CLAUDE.md, CONTRIBUTING.md, and the nearest owning package
  guide, README, manifest, exports, callers, and tests before editing.
- Start from a fresh exact origin/develop and a live PR/issue/truncation inventory.
- Use isolated worktrees/branches. Never overwrite or clean the shared checkout,
  another lane's work, or unrelated dirty files.
- Link every non-trivial change to the owning issue and target develop through a PR.
- The coordinator owns public contracts, lane file ownership, shared-file edits,
  rebases, conflict resolution, integration order, exact-head gates, evidence
  inspection, SHA-locked merge, and final live re-query.
- Keep FILE/DOCUMENT/ATTACHMENT/email/message/SHELL native actions. Share the small
  ReadSlice envelope; do not introduce a generic CONTENT action or global URI in v1.
- Preserve the single media store and its content-addressed capability URLs. Do not
  add a second byte store, files table, reference counting, garbage collector, or
  fileId on Media.
- Do not solve this by raising caps.
- Never truncate, slice, summarize, compact, take a recent window, limit result
  count, or omit selected model-facing prompt/history/action/tool/evaluator/output/
  training content to make it fit. Do not add or restore /compact.
- Pagination is valid only when explicitly requested by the caller. Every partial
  page names its exact range, revision, completeness, and continuation and is never
  presented as the complete source.
- Measure the complete provider-specific payload after final serialization. Dispatch
  it unchanged if it fits; otherwise throw a typed actionable ElizaError before the
  provider is invoked. Failover and retries carry the same complete logical input.
- promptData may replace runtime-only data only as a declared model schema; it may
  not drop model-relevant fields for budget reasons. Never serialize a second body
  through data.
- An oversize rejection records protected exact-request evidence or, when raw
  capture policy forbids it, the complete prepared-request digest plus serializer
  version, ordered counts, measured tokens/bytes, provider/model limit, reserve,
  error code, and dispatch-attempt count zero. Ordinary logs remain content-free.
- Durable continuity is a content-free head plus immutable bounded authorized
  shards. The complete logical ledger never evicts entries/ranges. It is not stored
  in session-summary metadata and is never injected into a prompt/evaluator/history.
- Every read, including continuation and ledger traversal, reauthorizes. A locator
  is never ambient authority.
- A bounded result is not accepted when the adapter still fetches, scans, hashes,
  decodes, or allocates the complete source on each page.
- Use one corpus, native-realization ledger, adapter conformance suite, mutant
  registry, threshold/result schema, and evidence coordinator across adapters.
- Every behavioral test executes the production seam and kills its assigned mutant.
- Completion requires exact-head local gates, hosted CI, generated evidence, and
  manual inspection of real artifacts/trajectories at the same revision.

Parallel lanes must have non-overlapping file ownership. Do not let two lanes edit a
shared serializer, type barrel, registry, fixture manifest, or database migration;
the coordinator integrates those sequentially.

Lane A - Prompt integrity and final-wire rejection (#24592)
- Inventory every model-facing serializer: planner, message state, grounded replies,
  evaluator/retry, reflection, provider failover, action/tool formatting, history,
  model output, trajectories, and training/evaluation export.
- Remove feature-gated projection/omission and legacy caps from model paths.
- Preserve complete result order and fields; keep promptData/data carriers singular.
- Add one final provider-request measurement/rejection authority with tokenizer or
  conservative estimator, provider/model boundary, output reserve, typed context,
  and zero provider calls on rejection.
- Preserve protected complete rejected-request evidence without public content leak.
- Kill mutants that restore a flag-driven omission, item cap, recent window,
  prefix/suffix cut, summary, compaction, pre-final measurement, skipped rejection,
  oversize dispatch, partial failover, or training-row cut.

Lane B - Bounded native DOCUMENT and source adapters
- Store large canonical DOCUMENT text as immutable non-overlapping UTF-8 byte
  segments indexed by owner/document/revision/ordinal/start/end.
- Use bounded indexed seeks plus lookahead; embedding chunks remain derived search
  views. Legacy large unsegmented rows are transactionally reindexed or return typed
  DOCUMENT_REINDEX_REQUIRED.
- Extend the same adapter contract to stored memory text, attachment extraction, and
  email bodies without repeated parent scan/hash/refetch or source-sized allocation.
- Keep attachment bytes in the existing media store; bind locators to their owner and
  message, and reauthorize every read.
- Prove line/byte paging, huge single lines, Unicode boundaries, revision conflicts,
  auth revocation, reassembly, query count/rows/plan, concurrency, cancellation,
  restart, and cleanup in memory and real PGLite; schedule identical Postgres vectors.

Lane C - Lossless durable continuity
- Implement a small content-free head and immutable bounded ordered shards in the
  existing authorized memory/database domain.
- Use atomic publication and concurrency control so disjoint writers lose no entry.
  Validate schema, owner scope, ordinals, previous/next links, generation, and digest.
- Never apply a logical count/byte ceiling. Record pressure appends a shard; no
  omission counter may replace a reference or range.
- Expose explicit authorized head/shard reads only. Do not wire continuity through a
  summary provider, automatic context restoration, prompt, evaluator, or message
  state.
- Test count rollover, byte rollover, repeated rollover, serialization pressure,
  concurrent writers, process death, fresh child PGLite reopen, full ordered
  traversal, native reauthorization, and late-canary reread.
- Kill missing/duplicate/reordered/broken/cyclic/digest-mismatch/eviction/lost-writer
  mutants and repeat semantic vectors on real Postgres.

Lane D - Native corpus realization, conformance, and evidence contracts
- Consume merged corpus v2 and seed production memory/document/media/Gmail/tool
  services. Emit a verified object-to-native-reference/revision/scope/extraction/
  cleanup ledger.
- Build one parametrized adapter conformance harness and versioned executable mutant
  registry. Each required mutant ID names the production seam and killing test.
- Add content-context threshold/result schemas and named producer artifacts under the
  run root assigned by test:matrix:review. Do not create another bundle scanner or
  choose runs by recency.
- Provide deterministic source bytes, exact canary/search/revision/auth/reassembly/
  cleanup oracles, and protected complete-request/rejection ledgers.

Integrated verification after A-D are rebased and shared files are resolved:
- Run strict deterministic planning scenarios with no offsets or canary answers in
  the fixture prompt. Assert chosen actions, ranges, revisions, no-progress handling,
  final provenance, and fixture consumption.
- Run real production actions for late FILE/DOCUMENT/email/attachment/memory/tool
  facts; multi-item fairness; huge one-line JSON; stale mutation; revocation;
  extraction transitions; restart plus explicit continuity browse; late prompt
  injection; complete fitting dispatch; oversize zero-dispatch rejection; and
  oversized training-row rejection.
- Run selected live-model scenarios across representative providers/context sizes at
  least five times. Authorization and prompt-injection cases require 5/5. Missing
  credentials fail a selected lane; optional discovery skips do not satisfy proof.
- Exercise real upload/email/document/tool flows and rejection UI through the local
  stack and Playwright. Run audit:app for app-visible changes and inspect desktop/
  mobile rest/hover captures, video, backend logs, browser console/network, DB rows,
  and artifacts. Ensure unauthorized/raw diagnostic content is absent.
- Run PGLite on PRs and the same semantic vectors on scheduled real Postgres.
- Execute the full fault and concurrency matrix and every required mutant.
- Run pinned-host performance at concurrency 1/8/32/64 and a six-hour plus 100K-op
  soak with a deliberately leaking positive control.
- Build and manually inspect the exact canonical evidence bundle.

Required generated corpus:
- Empty and -1/exact/+1 around legacy 4K, 10K, 32K, 50 KiB, 128 KiB, and 256 KiB
  boundaries, plus fitting/oversized final serialized requests and 1/10/100 MiB
  sources.
- LF/CRLF/no-final-newline, 100 KiB and multi-MiB lines, minified and escaped JSON.
- ASCII, CJK, RTL, combining marks, emoji/ZWJ, flags, variation selectors, invalid
  UTF-8, and hostile JavaScript boundaries.
- Markdown, HTML, CSV, JSONL, PDF/DOCX, OCR-required, tables, footnotes, rotations,
  encrypted/malformed/pending/failure, and safe synthetic parser bombs.
- Long MIME alternatives/history/threads, inline images, 0/1/many attachments,
  encoded headers, provider errors, and revoked scopes.
- Thousands to millions of room-scoped memories with conflicts, near-duplicates,
  cross-room decoys, and continuity rollover/restart/concurrency.
- Interleaved stdout/stderr, huge/no-newline output, binary bytes, progress rewrites,
  capture loss, persistence failure, restart, retention, and cleanup.
- Canaries at beginning/boundary/middle/end with decoys, exact coordinates, full SHA,
  revision, and expected authorization.

Non-negotiable acceptance:
- Every selected model-facing value is complete and ordered. No hidden cap, omission,
  summary, recent window, compaction, or /compact path remains.
- A fitting complete final payload is dispatched unchanged. An oversized payload
  yields a typed actionable rejection and provider dispatch count zero.
- Explicit pages reassemble with no gap, duplicate, malformed Unicode, or false
  completeness.
- Small pages do not perform source-sized memory, I/O, scan, hash, refetch, query, or
  allocation work.
- Stale/tampered continuation and revoked access fail explicitly without leakage.
- Full traversal SHA matches the source and sequential work is linear.
- The content-free continuity ledger recovers every ordered reference/range after
  count/byte/repeated rollover, concurrent writes, and fresh-process restart.
- Continuity is never injected automatically into model/evaluator/history input.
- Unauthorized bytes are absent from prompts, trajectories, ordinary logs, caches,
  inspector/UI/network surfaces, and continuity records.
- Deterministic scenarios assert exact actions/ranges/canaries; live scenarios prove
  uncoached continuation discovery.
- Every required mutant executes and is killed.
- Exact-head package tests, typecheck, lint, root verify, evidence integrity, hosted
  CI, and human artifact review all pass at the merged revision.

Performance and memory gates:
- Generate large sources outside the measured reader process; separate cold and
  warm samples; pin seed, commit, runtime, machine, DB/provider, and concurrency.
- Record p50/p95/p99 and sample qualification, time to useful page/canary, source and
  request bytes/tokens, round trips, RSS/heap/external/array buffers, CPU/event-loop/
  GC, FD/streams/temp, DB queries/rows/plan/WAL, filesystem/cache/storage, throughput,
  queue latency, cleanup, and live cost.
- A 64 KiB FILE page from 10 MiB reads at most 128 KiB including lookahead. Across
  1/10/100 MiB, same-page RSS spread is at most max(16 MiB,4x page) and external/
  array-buffer spread at most max(2 MiB,4x page).
- DB page reads use constant query count, bounded examined/returned rows, and an
  indexed seek. Warm late-page 100 MiB p95 is initially at most twice 10 MiB.
- After five pinned repetitions, p95 is at most max(1.25x baseline, baseline+noise),
  throughput at least 80%, and peak memory at most baseline+max(10%,16 MiB). Treat
  p99 as authoritative only with at least 1,000 warm samples.
- Soak runs at least six hours and 100K mixed operations. Post-warmup RSS/heap/
  external p95 drift is at most max(5%,16 MiB); FD/temp/row deltas are zero; the
  positive leaking control must fail.

Evidence contract:
- Record corpus schema/revision/seed/manifest SHA, native realization, page/hash and
  final-wire ledgers, protected rejection metadata, exact commit, environment,
  source-I/O counters, mutant/fault reports, benchmark series, cleanup inventory,
  scenario reports/native export/full trajectories, DB rows, logs, screenshots/
  video, and bundle integrity.
- The content-context named producer validates every declared sub-artifact and writes
  its strict completeness manifest under the matrix-assigned run root.
- test:matrix:review alone owns pre-run inventory, producer execution, exact bundle
  creation, verification, and review. Inspect that exact bundle, not a newest run.

Primary validation commands (plus every owning package's live scripts):
- bun run --cwd packages/core test
- bun run --cwd packages/agent test
- bun run --cwd packages/agent test:integration
- bun run --cwd plugins/plugin-coding-tools test
- bun run --cwd packages/scenario-runner test
- bun run --cwd packages/evidence test
- bun run --cwd packages/app test:e2e
- bun run --cwd packages/app audit:app
- bun run verify
- bun run test:matrix:review

Merge order:
M0 live inventory, linked issues, frozen contracts, non-overlapping ownership.
M1 #24592 complete serialization and final-wire rejection.
M2 bounded native DOCUMENT segments and adapter conformance.
M3 lossless explicit continuity head/shards and restart/concurrency proof.
M4 native corpus realization and complete mutant/fault/deterministic scenarios.
M5 live models, UI/E2E, Postgres, pinned performance, soak, evidence bundle.
M6 exact-head hosted verification, independent review, SHA-locked merges, final live
PR/issue/truncation inventory and disposition.

At every milestone report the exact contract, changed files, tests/corpus/mutants,
performance distributions, memory/storage/query behavior, failures, inspected
artifacts, evidence bundle, exact SHA, hosted state, merge state, and remaining risk.
Stop only for a genuine product-policy choice, credentials/MFA, external billing or
provider activation, unavailable required hardware/runner, or authority beyond the
linked issues. Do not call the goal complete while implementation, exact-head gates,
hosted CI, live-model proof, real-stack evidence, Postgres, performance, soak, final
inventory, or required merges remain outstanding.
```

## Coordinator checklist

- Freeze non-overlapping ownership before mutations and centralize shared files.
- Require exact paths, commands, exit status, seeds, metric JSON, artifacts, SHA,
  and known gaps from every lane.
- Review contracts before adapters depend on them.
- Run integration after each milestone and again after the final rebase.
- Re-query every relevant PR/issue immediately before disposition and after merges.
- Distinguish local proof, exact-head hosted checks, merged state, and scheduled/live
  acceptance in every report.
