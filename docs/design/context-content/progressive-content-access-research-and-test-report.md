# Progressive content access research and test report

Date: 2026-08-22

Research snapshot: `b82b9f4ca37e19036eb2f0282364b9f2a3382d14`;
implementation and hosted evidence remain attached to exact PR heads because
`develop` moves continuously

Canonical tracking: [#24286](https://github.com/elizaOS/eliza/issues/24286) and
prompt-integrity correction [#24592](https://github.com/elizaOS/eliza/issues/24592)

## Executive finding

The defect is not merely a 10K-character constant. Several historic elizaOS paths
could not distinguish an explicitly requested preview from irreversible loss, and
several apparent read-more operations returned a small response only after reading,
splitting, hashing, or rejecting the complete source.

The clean elizaOS design has two separate boundaries:

1. **Source access:** native FILE, DOCUMENT, ATTACHMENT, email/message, memory,
   and SHELL actions support explicit bounded reads with exact continuation.
2. **Model dispatch:** every selected prompt/history/action/tool/evaluator/training
   value remains complete. The final provider request is dispatched unchanged if
   it fits, or rejected before dispatch with a typed actionable size error.

Those boundaries must not be conflated. Pagination is a caller-visible source
operation. It is not permission for a prompt builder to omit, summarize, compact,
take recent items, or cut a selected result. A 1M-token model expands what may fit;
it does not justify hidden data loss or require the runtime to fill the window.

## Current delivery status

Merged:

- [#24305](https://github.com/elizaOS/eliza/pull/24305): shared progressive
  content contracts, bounded FILE foundations, and associated tests.
- [#24345](https://github.com/elizaOS/eliza/pull/24345): archive/reference-related
  follow-up.
- [#24521](https://github.com/elizaOS/eliza/pull/24521): refreshed research,
  specification, corpus, scenarios, benchmark, and evidence foundation.
- [#24496](https://github.com/elizaOS/eliza/pull/24496): deterministic corpus v2
  with strict publication and byte-backed verification.

Closed and not accepted as the continuity design:

- [#24498](https://github.com/elizaOS/eliza/pull/24498): same-runtime summary
  metadata plumbing was tested, but capped canonical rollover destroyed references
  and ranges. Summary metadata is also not an accepted prompt or persistence seam.
- [#24387](https://github.com/elizaOS/eliza/pull/24387): closed continuity attempt.

Active:

- [#24592](https://github.com/elizaOS/eliza/issues/24592): remove feature-gated
  projection/omission behavior and enforce complete final-wire serialization with
  typed rejection before provider dispatch.
- Truly bounded native DOCUMENT storage/read realization and conformance.
- A content-free continuity head plus immutable bounded shards, explicitly read
  and authorized, with restart/concurrency/losslessness proof.
- Native corpus realization and the complete mutant, fault, scenario, E2E,
  Postgres, performance, and soak matrix.

This status does not claim the full goal is complete. Stored memory/attachment and
connector paths still require proof that a bounded result does not hide full-parent
work. Live-model, real-stack UI, Postgres scale, and long-soak acceptance remain.

## Corrected architecture decision

Earlier drafts proposed an opt-in central prompt projector with per-result and
aggregate budgets, recoverable omission, summary-carried manifests, and future
compaction integration. That proposal is withdrawn. It violates the repository's
prompt-integrity invariant because model-facing completeness would depend on a
feature flag and a hidden serializer decision.

The accepted contract is:

- The model receives the complete caller-requested page and every other selected
  prompt, history, action/tool, evaluator, provider, output, and training field.
- `promptData` may be the declared canonical model schema while `data` remains
  runtime-only, but schema selection may not remove model-relevant fields to fit.
- The exact final provider payload is measured after all wrappers and schemas are
  serialized.
- A fitting request is dispatched unchanged.
- An oversized request produces a typed `ElizaError` before the provider is called.
- Protected trajectory evidence binds the complete prepared-request digest,
  serializer version, ordered counts, measured tokens/bytes, provider/model limit,
  reserve, error code, and zero dispatch attempts. Authorized raw capture, when
  enabled, is exact rather than truncated.
- No flag, failover, retry, evaluator, reflection, legacy formatter, message-state
  path, or training exporter can re-enable omission, summary, compaction, recent
  windows, item limits, or prefix/suffix cuts.

Durable continuity is also corrected. It is not session-summary metadata and it is
not injected automatically into model context. A small content-free head points to
immutable, bounded, ordered shards in the existing authorized memory/database
domain. The complete logical ledger never drops entries under record pressure.
Callers browse it explicitly, and every source reread reauthorizes independently.

## Research method and limits

- Audited maintained source and tests across core, agent, coding tools, documents,
  Google Workspace/inbox, scenario runner, evidence, training-related boundaries,
  and root orchestration.
- Re-queried the truncation PR wave and tracked merged/closed/active dispositions.
- Compared pinned OpenViking, Pi, Hermes Agent, and official Claude Code material.
- Separated source paging, UI/log previews, hard transport/security rejection, and
  model-facing destructive loss.
- Treated current manifests, source, tests, and exact PR heads as authority rather
  than old prose.
- Made no claims about closed-source Claude Code internals beyond official docs.

## Historical elizaOS baseline

This table records behavior that motivated the work. It is historical, not a claim
that every row still matches current `develop`. It also does not prescribe prompt
projection; the required model-facing fix is complete serialization plus rejection.

| Surface | Observed historical behavior | Risk | Correct contract |
| --- | --- | --- | --- |
| Classic action-result formatting | Last 8 results; text/error/data character cuts; nested reduction | Silent loss and unstable reasoning | Serialize every selected result completely; reject the final request if oversized |
| Planner rendering | Conditional native text caps and `promptData ?? data` ambiguity | Bypass or duplication | One declared model schema, complete fields, final-wire rejection |
| Coding FILE | Offset/limit existed but large files were rejected or read whole first | Misleading continuation | Positioned bounded I/O, revision, exact next offset |
| Coding GREP | Head-limited results with rerunnable query but weak total/cursor semantics | Partialness unclear | Explicit bounded-search contract and stable continuation where feasible |
| Background shell | Absolute offsets and eviction boundary | Useful precedent with retention constraints | Exact readback and explicit source-loss state |
| Terminal shell | Preview plus stored attachment; upstream capture could cut | Irreversible tail loss could look recoverable | Private complete lifecycle or typed source-loss failure |
| ATTACHMENT read | Fixed prefix for answering; full bodies could duplicate in data | Loss, duplication, first-item starvation | Explicit selected-item pages and exact continuation |
| Attachment provider | Small preview and omitted count | Valid only as a named UI/navigation preview | Provide an authorized full read path; never reuse preview as complete model content |
| Documents | Whole exact reads and pinned-object omission | Storage/access mismatch | Indexed immutable segments and exact reads |
| Gmail/inbox | Snippets often retained while body fetch existed elsewhere | Retrieval seam missing | Authorized message-body reads with stable revision |
| Email classifier | Short prefix used for a cheap classifier | Incomplete input if treated as full message | Use only for an explicitly scoped preview classifier; full decisions require explicit full/pages contract |
| Workspace initialization | Per-file and aggregate caps | Omitted source identity | Explicit manifest and later native read; no claim that startup preview is complete |
| SQL JSON | Fail-closed object-size bound | Correct safety rejection | Preserve rejection; store large source in native segments/references |
| Session continuity | Removed compaction modules; no durable mechanical ledger | Restart loses navigation state | Explicit authorized head/shards, never automatic summary/model injection |

The surrogate-safe truncation PR wave improved Unicode hygiene in some helpers, but
Unicode-safe deletion remains deletion. Tests that reproduce a helper without
executing the production model or native-read path are mutation-blind.

## External technical findings

The following systems are research observations, not elizaOS requirements. Their
compaction, truncation, summarization, or automatic context-clearing strategies are
specifically **not adopted** for elizaOS model-facing content.

### OpenViking

OpenViking documents typed `viking://` identity, L0/L1/L2 context layers, durable
large-result externalization, retrieval APIs, hashes, provenance, and progressive
detail loading: [context layers](https://github.com/volcengine/OpenViking/blob/2af48624e03b2df6922ab82c6720eb71439c805a/docs/en/concepts/03-context-layers.md)
and [retrieval API](https://github.com/volcengine/OpenViking/blob/2af48624e03b2df6922ab82c6720eb71439c805a/docs/en/api/06-retrieval.md).

Useful observations are stable source identity, explicit total/`has_more`, exact
offsets, provenance, and durable raw-result ownership. Its layered abstracts and
overviews are navigation aids in that system; elizaOS does not adopt them as an
automatic substitute for selected model context.

The implementation also illustrates why response shape is insufficient. A
progressive API may still materialize the complete object, and summary generation
can itself overflow on large directory inputs. A reported 100MB case produced very
large overview prompts before correction
([OpenViking #674](https://github.com/volcengine/OpenViking/issues/674)). elizaOS
therefore measures process memory, I/O, queries, and allocation as well as output.

### Pi

Pi's coding tools expose line offset/limit with line/byte ceilings, visible
truncation metadata, saved command output, and compaction that preserves some tool
boundaries/file lists. Its extension docs warn that truncation without recovery
breaks downstream behavior
([tool-output contract](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)).

Useful observations are explicit continuation and durable readback. elizaOS does
not adopt Pi's automatic caps or compaction as a model-input policy; it uses
caller-requested paging and rejects an oversized complete final request.

### Hermes Agent

Hermes has exposed line paging, character and aggregate output controls,
`next_offset`, and persisted overflow. Its issue history provides valuable corpus
cases:

- A long line can be cut so valid source appears corrupted
  ([#16520](https://github.com/NousResearch/hermes-agent/issues/16520)).
- Escaped persisted JSON can become one physical line and defeat line-only paging
  ([#79818](https://github.com/NousResearch/hermes-agent/issues/79818)).

These observations motivate byte paging beneath line views and exact decoded
boundaries. elizaOS does not adopt automatic per-result/aggregate omission.

### Claude Code

Official documentation describes on-demand instruction/file loading, old-tool
output clearing, compaction, isolated subagent contexts, reinjection behavior, and
`/context` observability. A larger context changes auto-compaction capacity but does
not eliminate context management: [context window](https://code.claude.com/docs/en/context-window),
[memory](https://code.claude.com/docs/en/memory),
[subagents](https://code.claude.com/docs/en/sub-agents), and
[commands](https://code.claude.com/docs/en/commands).

Useful observations are deliberate reads, isolated research contexts, and visible
context accounting. Automatic output clearing, summarization, reinjection, and
compaction are observed Claude Code product choices, not adopted elizaOS behavior.
Claude Code internals and exact read limits are closed and were not inferred.

## Simplified target architecture

Use one of each:

- `ContentReference`/`ReadSlice`/`ReadView` contract.
- Native adapter conformance harness.
- Deterministic corpus source/oracle manifest.
- Native-realization ledger mapping corpus IDs to references, revisions, scopes,
  extraction state, and cleanup identity.
- Complete final-wire size authority.
- Content-free continuity head plus immutable shard schema.
- Checked-in mutant registry and threshold policy.
- Content-context evidence producer under the canonical matrix coordinator.

Do not add per-adapter truncators, separate generators/report roots, automatic
prompt projectors, summary carriers, a universal filesystem, or another content
store. Existing scenario isolation, Gmail fault controls, PGLite/Postgres tooling,
Playwright/app audit, and evidence bundling remain the execution engines.

## Testing strategy

### Layered proof

| Layer | Harness | Required proof |
| --- | --- | --- |
| Pure contract | Vitest + seeded property tests | Range algebra, hostile shapes, Unicode, continuation, exact reassembly |
| Serializer/model boundary | Production prompt/evaluator/provider builders | Complete order/fields, exact fitting dispatch, typed oversize rejection, zero provider calls |
| Native adapter conformance | One parametrized suite | Resolve/auth/stat/read/revision/reassembly/source-work/cleanup semantics |
| Real persistence | Temp filesystem + PGLite | Transactions, indexes, ACLs, child-process restart, concurrent writers, cleanup |
| Deterministic action scenario | Scenario runner, model-free | Production handlers reach late pages and return exact typed states |
| Deterministic planning | Strict fixture model without canary answers | Agent discovers continuation and answers from exact late evidence |
| Isolation | Isolated scenario processes | No cross-run memory, reference, cache, or embedding leakage |
| Live model | Selected credentialed scheduled lane | Representative models discover explicit reads without coaching |
| API/UI E2E | Real local stack + Playwright | Upload/email/document/tool flow, visible partial page, explicit later read, rejection UI |
| Performance/soak | Fresh child processes + pinned hosts | Source-size invariance, DB work, latency, memory, FD, cleanup, leak control |
| Evidence | Canonical bundle pipeline | Exact-revision reports, trajectories, logs, DB/artifact rows, screenshots/video |

Unit tests cannot prove autonomous behavior. Live-model tests cannot prove
losslessness, zero dispatch on rejection, or bounded source work. Both are required.

### Generated corpus

Corpus v2 is merged through #24496. Large payloads are generated into owner-only
temporary run roots rather than committed. Publication is manifest-last and atomic;
only paths from a previously verified owned manifest may be replaced or removed.
The verifier rejects unsafe mode, undeclared files, symlink/hardlink targets,
tampered format oracles, missing extraction declarations, and hash/revision drift.

Profiles:

| Profile | Default scale | Lane |
| --- | --- | --- |
| `micro` | 20 objects, under 2 MiB | Unit/property |
| `pr` | 64 files/docs, 2K memories, 128 emails, 32 attachments, 25–50 MiB | Required deterministic PR |
| `nightly` | 5K objects, 100K memories, 10K emails, 2K attachments, about 1 GiB | Scheduled integration/performance |
| `release` | 50K objects, 1M memories, 100K emails, 10 GiB logical content | Pinned-host release |
| `soak` | Six hours and at least 100K mixed operations | Dedicated runner |

Content families include:

- Empty and boundary-size text/code; LF/CRLF/no-final-newline; sparse/dense hits.
- 1 KiB through multi-MiB lines, minified JSON, and escaped JSON newlines.
- ASCII, CJK, Arabic/RTL, combining marks, emoji/ZWJ, flags, variation selectors,
  invalid UTF-8, and hostile JavaScript boundaries.
- Markdown, HTML, CSV, JSONL, text and image-only PDFs, DOCX, nested MIME,
  OCR-required, pending, failed, malformed, encrypted, tables, footnotes, rotations.
- Long email alternatives/history/threads, inline images, many attachments,
  encoded headers, and revoked connector scopes.
- Large attachment transcripts, last-item canaries, and extraction transitions.
- Large room-scoped memories, conflicts, decoys, cross-room temptations, and
  continuity-ledger rollover/restart.
- Interleaved stdout/stderr, huge/no-newline output, binary bytes, progress rewrites,
  capture loss, process restart, retention, and persistence failure.
- Late-page prompt injection, safe synthetic archive/MIME bombs, source mutation,
  malformed ranges, tampered revisions, and stale generations.

Every object has unique canaries at beginning, boundary, middle, and end; a similar
decoy; exact coordinates; checksums; revision; and expected authorization. A native
realizer must seed production services and emit object-to-native reference/scope/
revision/extraction/cleanup mappings. Family-named files alone are not native proof.

Mandatory mechanical oracles include full traversal SHA, no gaps/duplicates,
search postings and decoys, revision before/after hashes, unauthorized-byte absence,
single content carrier, exact successful final serialization, exact rejected-request
digest, zero provider dispatch on rejection, ledger entry recovery, fair multi-item
retrievability, and cleanup to declared DB/disk/cache/FD/stream baselines.

### Required scenarios

1. Read a late FILE fact past the old 256 KiB barrier.
2. Search then explicitly expand a late DOCUMENT range.
3. Triage a named email preview, then explicitly read body and attachment pages.
4. Compare facts across three attachments without first-item starvation.
5. Recover a failure cause from complete private tool output or typed source loss.
6. Restart, explicitly browse the continuity ledger, reauthorize, and reread a late
   range.
7. Detect mutation between pages and restat/replan.
8. Reject a continued read after authorization revocation.
9. Navigate multi-megabyte one-line JSON without malformed evidence.
10. Resist instructions planted only in a later external-content page.
11. Handle extraction pending/failure and later readiness.
12. Prove room isolation against a cross-room decoy.
13. Dispatch a fitting complete request byte-for-byte.
14. Reject an oversized complete request before provider invocation and expose an
    actionable typed error without a partial fallback.
15. Reject a training row that exceeds its sequence boundary without training on a
    cut or summarized row.

Deterministic scenarios assert exact action arguments, ranges, revisions, ordering,
and canary provenance. Live scenarios retain complete protected trajectories and
combine independent judging with mechanical canary checks.

### Architectural mutants

The versioned registry must execute and kill 100% of required IDs:

- Whole-source read/scan/hash/refetch and source-sized allocation.
- Missing revision, range, digest, or authorization validation.
- Unicode corruption, middle-page omission, duplicate/shifted pages, false
  completeness, or unrelated artifact identity.
- Legacy result cap, recent history window, prefix/suffix cut, item limit, summary,
  compaction, omitted page, or feature flag that silently changes model content.
- Pre-final measurement, skipped rejection, provider call after rejection, oversize
  dispatch, or partial provider fallback.
- Duplicate body carrier or dropped model-relevant `promptData` field.
- Ledger entry eviction, omission-counter substitution, lost concurrent write,
  broken/skip/repeat/reorder/cycle link, digest mismatch, or unauthorized read.
- Selected live-lane credential absence converted into a skip.

### Fault and concurrency matrix

Inject at resolve, authorize, stat, read, search, extraction, persistence,
continuation validation, final serialization, provider dispatch, database commit,
connector refresh, ledger publication/traversal, and cleanup. Cover cancellation,
short read, mid-page failure, TOCTOU, metadata/body split-brain, delete/replace,
index lag, backpressure, decompression/OCR bombs, disk full, retention expiry,
process death, corrupt shards, provider 401/403/404/409/429/5xx, and cleanup races.

Concurrency covers readers at one revision, writer/read races, revocation mid-read,
deduplicated publication, disjoint ledger writers, cleanup/expiry versus readers,
cancellation, and retry idempotence. Oracles require no fabricated completeness,
shifted continuation, unauthorized fallback, lost ledger entry, provider call after
rejection, leaked handle, or source loss mislabeled as recoverable.

## Performance and memory plan

Record:

- End-to-end p50/p95/p99, time to first useful page, and time to canary.
- Resolve/auth/stat/read/search/extract/serialize/final-wire/provider latency.
- Source bytes read versus returned; request bytes/tokens; round trips; no-progress
  reads; complete rejection measurements.
- RSS, heap, external memory, array buffers, CPU, event-loop delay, GC count/pause.
- File descriptors/streams/temp artifacts and cleanup deltas.
- DB query count/duration, rows examined/returned, pool wait, plan, index/table size,
  and WAL attribution.
- Filesystem and cache bytes, extraction/embedding work, throughput and queue latency
  at concurrency 1/8/32/64, and live-model cost per recovered canary.

Method:

- Use fresh child processes; generate/write large sources outside the measured
  reader or release the generator buffer before the baseline.
- Separate cold and warm samples; report distributions and sample qualification.
- Pin seed, exact commit, runtime/model versions, machine/OS/CPU/RAM, DB/provider,
  concurrency, and warm state.
- Establish latency thresholds after five stable pinned-host repetitions. Report
  authoritative p99 only with at least 1,000 warm samples.
- A 64 KiB FILE page from a 10 MiB source reads at most 128 KiB including bounded
  lookahead. Sequential traversal is linear and reassembles the source SHA.
- Across 1, 10, and 100 MiB sources, same-page peak RSS spread is at most
  `max(16 MiB, 4 × page size)` and external/array-buffer spread is at most
  `max(2 MiB, 4 × page size)`.
- Native DB pages use constant query count, bounded returned/examined rows, and an
  indexed seek plan. Warm late-page p95 at 100 MiB is initially no more than twice
  the 10 MiB result before baselines tighten.
- After baseline, p95 is at most `max(1.25 × baseline, baseline + noise band)`,
  throughput at least 80%, and peak memory at most baseline plus `max(10%,16 MiB)`.
- Soak runs six hours and at least 100K mixed operations. Post-warmup RSS/heap/
  external p95 drift is at most `max(5%,16 MiB)`; FD/temp/row deltas are zero. A
  deliberate leak must fail the detector.

A fitting complete request must remain within the measured provider boundary after
final serialization. An oversized request must show zero provider dispatches; it is
not a benchmark success merely because a cut request was faster.

## Harness and evidence integration

- Use `packages/scenario-runner` for real-runtime behavior and isolated processes
  for isolation-sensitive scenarios.
- Use strict deterministic model fixtures without planted answers for PR planning.
- Use PGLite in PR lanes and the same semantic vectors on real Postgres in
  scheduled lanes.
- Add one `reports/content-context/` producer/ingestor and a producer-to-bundle
  regression test. `test:matrix:review` remains the only pre-run inventory, run,
  bundle creation, verification, and review owner.
- Include corpus manifest/seed/SHA, native realization, page/hash ledger,
  serializer/final-wire ledger, protected rejection metadata, source-I/O counters,
  mutant and fault reports, benchmark environment/series, cleanup inventory,
  scenario/native export/trajectories, DB rows, backend/browser/network logs,
  screenshots/video, and bundle integrity.
- Selected credentialed lanes fail when credentials are missing. Optional discovery
  jobs may skip but cannot satisfy live acceptance.
- UI work uses the real local stack, Playwright recording, and `audit:app`, with raw
  content absent from unintended DOM/network/console surfaces.

The scenario judge may use bounded diagnostic rendering only when that rendering is
never presented as the model input or completeness oracle. Exact content proof uses
mechanical request/source/hash ledgers.

## Rollout recommendation

1. Complete #24592: eliminate prompt omission/projection paths, cover every model
   serializer and training boundary, and enforce final-wire typed rejection.
2. Complete indexed native DOCUMENT segments and shared conformance.
3. Complete content-free durable ledger head/shards with fresh-process,
   concurrency, authorization, and integrity proof.
4. Realize corpus v2 through every production native source.
5. Execute the full mutant/fault/deterministic-planning matrix.
6. Add provider-qualified live trials, real-stack E2E, Postgres, pinned-host
   performance, leak-controlled soak, and canonical evidence review.
7. Re-query and disposition every remaining truncation PR/path at exact head.

Do not raise constants or introduce an interim automatic projector. Either an
explicit source page was requested and is clearly partial, or the selected model
request is complete and fits. Otherwise fail before dispatch.

## Open questions with recommended answers

- **Should a caller request a full object?** Yes. If the source action has an
  external hard boundary, the caller explicitly pages it; the runtime never calls
  one partial page the full object.
- **Should summaries navigate sources?** They may be separately requested and
  clearly labeled, but they are not authority and never replace selected input.
- **Should continuity be injected automatically after restart?** No. Store a
  content-free head plus immutable shards and expose explicit authorized reads.
- **Should model-input overflow trigger compaction?** No. Return a typed actionable
  rejection before provider dispatch.
- **Should raw content remain available?** Under its existing authorization and
  retention policy, yes; paging is not deletion.
- **Should test corpora be committed?** Commit generators, schemas, tiny goldens,
  and hashes; generate large payloads in isolated run directories.
- **Should live models be the primary gate?** No. Deterministic mechanical gates
  prove integrity; repeated live trajectories prove planning robustness.
- **Should every size × encoding × source combination run on each PR?** No. Use
  pairwise PR coverage, targeted full shards nightly, and seeded randomized cases.

## Conclusion

The smallest correct elizaOS architecture is native source ownership, one explicit
slice envelope, one complete final-wire acceptance point, one lossless content-free
continuity ledger, one corpus, one adapter suite, and one evidence path. Other
systems' paging and identity ideas are useful research. Their automatic truncation,
summary, clearing, and compaction behaviors are not adopted.
