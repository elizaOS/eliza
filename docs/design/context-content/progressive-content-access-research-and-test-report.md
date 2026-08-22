# Progressive content access research and test report

Date: 2026-08-22

Third-pass research snapshot: `b82b9f4ca37e19036eb2f0282364b9f2a3382d14`; exact-head implementation evidence lives on each PR because `develop` is moving continuously

Canonical tracking issue: [#24286](https://github.com/elizaOS/eliza/issues/24286)

## Executive finding

The problem is not that elizaOS sometimes shows a 10K-character preview. The problem is that several model-facing boundaries cannot distinguish a bounded preview from irreversible loss, and several “read more” paths either do not exist or still materialize/reject the complete source before slicing it.

The best elizaOS v1 is smaller: keep native FILE, DOCUMENT, ATTACHMENT, email/message, memory, and SHELL actions; give them one `ReadSlice` continuation envelope; and unify prompt projection around the existing model-input budget. Native services retain identifiers and authorization. A generic action/URI and private raw-output spill layer come later only if measured need and lifecycle requirements justify them.

This pass concentrated on proof: generated corpora, fault models, scenario/E2E architecture, live-model behavior, and speed/memory measurements. It also looked for architecture that can be deleted or unified rather than adding another framework.

## Implementation pass result

The accompanying feature branch implements the coherent, keyless v1 slice rather than pretending the entire long-term test matrix is already automated:

- One strict `ContentReference`/`ReadSlice`/`ReadView` contract with exact zero-based half-open ranges, SHA-256 page proofs, revision-bound continuation, and hostile-shape rejection.
- Opt-in native trajectory planner/evaluator projection via `ELIZA_PROGRESSIVE_CONTENT_PROJECTION`. The projection replaces full structured bodies with validated page or nested reference metadata under per-result and aggregate model budgets. Diagnostics contain counts and token estimates only—no content, paths, references, provider IDs, or hashes.
- Production paging for coding FILE, stored DOCUMENT text, stored ATTACHMENT text, stored MESSAGE memories, Gmail bodies, and persisted terminal-output attachments. Continuations reauthorize and/or re-resolve the native source.
- Native positioned FILE reads with bounded lookahead and revision-keyed sparse line checkpoints. A 10 MiB page does not call whole-file `readFile`.
- A database-adapter document range capability that bounds runtime transfer and rechecks document authorization. Because the current document parent is one JSON text value, the SQL implementation still scans/splits that value server-side to count units and fingerprint revisions; genuinely source-independent document I/O requires indexed fragment/line storage and is not claimed here.
- A deterministic streamed corpus generator covering exact legacy thresholds, LF/CRLF/no-final-newline, single-line/minified content, invalid UTF-8, planted canaries, scopes, hashes, and micro/PR/nightly/release profiles. The corpus-v2 follow-up adds minimal real Markdown/HTML/CSV/JSONL/PDF/DOCX/MIME goldens, image-only OCR-required and unsupported-binary states, exact normalized-text canary coordinates, and a byte-backed verifier.
- A bounded isolated-scenario runner and a 13-turn, model-free production-action scenario. It proves exact late-page access, revisions, mutation rejection, cross-room denial, Gmail reauthorization, and absence of duplicate page carriers; it does not prove autonomous model planning.
- Canonical `reports/content-context/` evidence ingestion and a fresh-child-process FILE benchmark with revision, corpus, latency, throughput, I/O, CPU/event-loop, memory, descriptor, traversal-hash, and prompt-amplification fields.

Focused proof after the final rebase included 153 core contract/action tests with two pre-existing document-harness failures subsequently repaired, five real-PGLite authorization/range tests over a 10 MiB document, 45 coding/terminal/benchmark tests, 37 connector/corpus/evidence tests, and the 13-turn isolated scenario. Final exact-head package and repository gates are recorded with the PR rather than frozen into this design note.

The first 1,000-operation 10 MiB FILE benchmark was a calibration run, not a CI budget: p50 0.987 ms, p95 4.726 ms, p99 21.231 ms, 1,485 operations/second, and 97.34 MiB/second. A 64 KiB request read 65,539 bytes including bounded UTF-8 lookahead for both 1 MiB and 10 MiB sources, and full traversal matched the source SHA. This establishes serialization/I/O invariance, not yet RSS invariance; final reports preserve the raw memory samples and are rerun on the exact PR head.

Deliberate remaining boundaries are explicit: legacy prompt builders using `formatActionResultsForPrompt` are not yet routed through the final-request budget, and there is no private shell-output spill lifecycle, generic content URI/action, context-inspector UI, live-provider trajectory, or soak/Postgres matrix in the keyless PR lane. Stored memory and attachment reads still materialize their existing database row, Gmail fetches the provider body before slicing, and the small real-format goldens do not yet cover rotated/footnoted/table PDFs, encrypted or malformed files, production OCR output, long MIME alternatives, inline images, attachment cardinalities, oversized trees, or threads. These are not described as complete central-projection, production-extractor, or bounded-source-I/O proof.

### Second-pass completion audit

The post-merge audit found four priority corrections for M4. First, the native trajectory projector was not yet the only model-facing ActionResult serializer: ActionState, post-turn evaluation, reflection, message state, and grounded action replies retained full-body bypasses. Second, no runtime-derived content manifest existed for an archive or future compaction seam. Third, multi-attachment results retained only the first `ReadView`, and oversized pinned documents could disappear without an item-specific identity/reference. Fourth, the FILE benchmark and deterministic action scenario were useful but materially narrower than the goal's performance and autonomous-planning acceptance.

The M4 follow-up therefore stays deliberately small:

- Share one feature-gated legacy/native ActionResult projection implementation, with `promptData` replacing `data` and typed failure for nonrecoverable overflow.
- Add a versioned, strict, content-free reference/range manifest derived identically from active and archived trajectory steps; do not restore automatic compaction or add storage.
- Retain every attachment `ReadView` and give every oversized pinned document a fair excerpt plus its document identity/reference.
- Keep private tool-output spill in M5, after authorization, retention, atomic publication, redaction, and reference-aware GC over the existing content-addressed byte layer are approved.

This does not close the full goal. The completion audit still requires truly bounded document/message/attachment storage reads, measured Gmail acquisition caching, fresh-process database readback of the room-scoped manifest, deterministic autonomous planning, credentialed live-model trials, broad production-extractor format matrices, context-inspector E2E, real Postgres, the full architectural mutant catalog, and soak/performance evidence.

### Third-pass testing and architecture audit

The 2026-08-22 pass re-read the production adapters, database implementations, scenario/evidence infrastructure, performance benchmark, current PR heads, and the Pi, Claude Code, Hermes, and OpenViking findings. Two bounded lanes are now independently reviewed but deliberately incomplete:

- Closed [#24498](https://github.com/elizaOS/eliza/pull/24498) proved same-runtime sanitization and session-summary metadata plumbing for document and stored-memory references, but maintainer review correctly rejected its lossy canonical rollover. Its 31 focused core tests, 20 scenario fixture/coverage tests, core typecheck, FILE benchmark test, static checks, and independent patch-equivalence review did not prove fresh-process continuity or overflow recovery; those missing oracles are now P0.
- [#24496](https://github.com/elizaOS/eliza/pull/24496) publishes corpus schema v2 with private manifest-last atomicity, prior-verified-manifest ownership, code-derived format oracles, full deterministic streamed hashes, and mutation-sensitive tests. Minimal Markdown/HTML/CSV/JSONL/PDF/DOCX/MIME/OCR-required/failed fixtures passed independent tools. It is fixture-publication proof, not production-extractor or native-adapter proof.

The dominant remaining gap is now measurable: a bounded response is not a bounded system. Stored MESSAGE and ATTACHMENT readers still materialize/hash their complete row or extracted text. DOCUMENT bounds JS transfer but can scan, split, count, and fingerprint the complete parent JSON value for each page. Gmail refetches/decodes the body and relies on process-local continuation state. These are P0 acceptance failures for large-source behavior, even when the returned `ReadSlice` is correct.

Maintainer review closed #24498 on a separate semantic-loss defect: its persisted canonical union applies fixed reference/range/count/byte ceilings and keeps only omission high-water counters for evicted entries. That is destructive truncation of the traversal index. The required repair is lossless ordered shards in the existing authorized memory/database domain, with a restart-safe head/next reference and integrity metadata. Storage records and model projection stay bounded; the logical canonical ledger does not drop entries. Acceptance recovers every reference/range after repeated count and serialization rollover and after a fresh-process restart.

| Proof boundary | Current proof | Required next proof |
| --- | --- | --- |
| Corpus publication | Deterministic v2 files and strict trusted oracles | Realize the same objects through native memory/document/media/Gmail/tool services and emit an object-to-reference/revision/scope ledger |
| Handler behavior | Direct production-action scenario and focused adapter tests | One shared production adapter conformance harness with I/O, auth, revision, reassembly, cleanup, and mutation counters |
| Planner behavior | Strict fixture planning scenario under review; direct-action scenario is model-free | Prompt omits offsets/canaries; assert discovered continuations, fairness, no-progress handling, exact final provenance, and fixture consumption |
| Durability | Sanitized summary manifest persistence in one runtime; current capped union is lossy | Lossless addressable shard rollover; writer child terminates; reader child reopens PGLite, traverses every entry, reauthorizes, and reaches late canaries; repeat vectors on Postgres |
| Source work | FILE performs positioned bounded reads | Indexed document/message/attachment/email segments; constant page-query count with bounded rows; no repeated parent scan/hash/refetch or source-sized allocation |
| Mutation/faults | Corpus publisher kills four re-signed/security mutations | Versioned runtime mutant registry with 100% required-ID execution/kill plus resolve/auth/stat/read/persist/commit/cleanup fault matrix |
| Product behavior | No context inspector | Authenticated redacted inspector API/UI and real-local Playwright desktop/mobile proof with raw content absent from DOM/network/console |
| Operational acceptance | FILE calibration report | All-source pinned-host baseline, concurrency 1/8/32/64, real Postgres, provider-qualified repetitions, six-hour/100K-op soak, canonical evidence bundle |

The simplification is one corpus with two layers (trusted source/oracle manifest and native-realization ledger), one parametrized adapter conformance suite, one checked-in threshold policy, one content-context result schema, and one run coordinator. Existing scenario isolation, Gmail fault controls, real-local Playwright, Postgres runner, and evidence bundle tooling remain the execution engines. Separate generators, report roots, adapter-local truncators, or a universal filesystem would add complexity without strengthening proof.

## Method and limits

- Audited maintained source and tests in core, agent, app-core, coding tools, documents, Google Workspace/inbox, scenario runner, evidence, and root test orchestration.
- Re-queried current PR/issue state, including the closed surrogate-only truncation PR wave, corpus PR #24496, rejected/closed continuity PRs #24387/#24498, and open issue #24286.
- Compared pinned source/docs from OpenViking, Pi, Hermes Agent, and official Claude Code documentation.
- Distinguished prompt/display caps, recoverable projections, transport/security bounds, and destructive truncation.
- Made no claims about Claude Code internals that its official documentation does not expose.
- Work was performed in isolated worktrees; no claim is based on the dirty shared checkout.

## Pre-implementation baseline findings

This table records the truncation inventory that motivated the initial implementation. It is historical, not a claim about current `develop`: bounded coding FILE I/O, the shared slice contract, and opt-in projection have since landed. The third-pass audit above is the current gap authority.

| Surface | Current behavior | Assessment | Required change |
| --- | --- | --- | --- |
| Classic action-result prompt formatting | Last 8 results; text 4K chars, error 2K, data 4K; nested objects/arrays reduced | Broad destructive seam; path-key references are ad hoc | Model-safe reference + `ReadSlice`; prompt-only projection; aggregate budget |
| Planner rendering | Native tool messages can cap text conditionally, but serialize `promptData ?? data` and can duplicate/bypass bounds | Inconsistent with classic formatting | One projection authority; full content never rides in `data` |
| Coding FILE | Offset/limit and 2K-line default, but rejects sources over 256 KiB and reads whole file first | Continuation is misleading | Bounded I/O, source-independent paging, next offset/revision |
| Coding GREP | Head limit and rerunnable query, no total/stable next page | Partial | Cursor or explicit bounded-search completeness metadata |
| Background shell | Absolute offsets and eviction boundary | Good local precedent | Adapt to shared content view and durable spill |
| Terminal shell | Bounded preview plus stored output attachment, but upstream capture can truncate | Strong precedent with one remaining loss boundary | Standard readback and explicit upstream-loss state |
| ATTACHMENT read | First 32K chars used for answering; full bodies can be copied into data; early item can starve later items | Destructive and duplicative | One exact selected-item view per read plus native search/range reads; defer a general relation graph |
| Attachment provider | Three-item preview with IDs and omitted count | Appropriate preview | Point to a genuinely pageable read path |
| Documents | Good chunk ingestion/search; exact read returns and duplicates whole document; pinned 8K budget can omit whole object | Storage exists, access layer missing | Exact range/adjacency and identity fallback |
| Gmail/inbox | Triage commonly retains only snippet/subject although internal body fetch exists | Retrieval seam is missing | Authorized native message-body reads with model-safe references |
| Email classifier | 800-char prefix | Reasonable cheap classifier input, not sufficient content access | Preserve cap, attach later full-read path where decisions need it |
| Workspace init | 20K per file/100K total; omitted files lack a uniform read reference | Appropriate bounded startup, weak continuation | Identity manifest and model-safe native references |
| SQL JSON | 1 MiB fail-closed | Correct safety boundary | Keep raw bodies out of JSONB and store references |
| Session/archive continuity | Former automatic conversation-compaction modules are absent on current `develop`; retained planner/archive seams have no mechanical content manifest | Do not restore removed machinery | Preserve native references in retained steps now; define a runtime-derived reference/range manifest for any future compaction seam |

The current PR wave around surrogate-safe truncation is Unicode hygiene. It should be retained where correct, but it does not solve addressability, later retrieval, or prompt-budget architecture. Tests that locally reproduce a truncation helper without exercising the production call path are mutation-blind.

## External technical findings

### OpenViking

OpenViking's strongest ideas are its typed `viking://` resource identity, L0/L1/L2 progressive context, and durable externalization of large tool results. Its documented context layers use a short abstract, an overview, then original detail loaded on demand. Retrieval normally starts from the compact layer and progressively loads more: [context layers](https://github.com/volcengine/OpenViking/blob/2af48624e03b2df6922ab82c6720eb71439c805a/docs/en/concepts/03-context-layers.md), [retrieval API](https://github.com/volcengine/OpenViking/blob/2af48624e03b2df6922ab82c6720eb71439c805a/docs/en/api/06-retrieval.md).

Its tool-result store records raw output, SHA-256, MIME, preview counts, provenance, URI, and Unicode-code-point offsets; readback reports totals and `has_more`, and search returns match offsets. Aggregate tool-result budgeting externalizes large results rather than deleting tails. These are directly useful patterns for elizaOS.

The caution is equally valuable: a progressive API can still read an entire object before slicing, and summary generation itself can overflow on very large directory inputs. A reported 100MB document case showed overview prompts reaching tens of thousands of tokens before a fix ([OpenViking #674](https://github.com/volcengine/OpenViking/issues/674)). elizaOS tests must therefore measure process memory and I/O, not just response shape.

### Pi

Pi's coding tool contract uses line offset/limit and a dual 2,000-line/50 KiB output ceiling. Truncation metadata reports returned versus total lines/bytes, and large command output can be saved to a file for later reading. Its compaction respects tool-call/result boundaries and preserves file lists.

The useful lesson is clear notices plus a recoverable artifact. The limitations are path-based temporary durability, whole-file materialization in ordinary reads, and no single typed content layer across sources. Its own documentation emphasizes that truncation without a recovery path can break compaction and model behavior: [Pi extension tool-output contract](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md).

### Hermes Agent

Hermes currently provides line paging, a character budget, `next_offset`, per-result/aggregate output controls, and persisted overflow. It also illustrates two failure modes the elizaOS corpus must include:

- Long individual lines can be truncated in a way that makes valid source look corrupted ([Hermes #16520](https://github.com/NousResearch/hermes-agent/issues/16520)).
- A persisted JSON tool result can become one escaped physical line, making line-based offset/limit unable to reach the rest ([Hermes #79818](https://github.com/NousResearch/hermes-agent/issues/79818)).

Therefore the shared contract needs byte paging underneath line views, with decoded-boundary rules, and persisted output must preserve a pageable representation. Unicode-code-point random access can wait until an adapter has an index that makes it worthwhile.

### Claude Code

Official documentation confirms a context strategy based on on-demand file/instruction loading, clearing old tool output before full compaction, fresh isolated subagent contexts, re-injection rules after compaction, and `/context` observability. A 1M context changes auto-compaction capacity but does not eliminate context management ([context window](https://code.claude.com/docs/en/context-window), [memory](https://code.claude.com/docs/en/memory), [subagents](https://code.claude.com/docs/en/sub-agents), [commands](https://code.claude.com/docs/en/commands)).

Particularly relevant details:

- Root instructions and auto memory are re-injected; nested/path-scoped instructions reload on demand.
- Auto memory loads only a concise index initially and reads topic files later.
- Subagents keep verbose research/file reads out of the parent context and return summaries.
- `/context` explains consumption and optimization opportunities.

The implementation is closed, so exact internal read limits and compaction schemas remain unknown.

## Simplification decisions

The proposed design deliberately removes concepts:

- Replace hard-coded “full output path” key detection with typed native locator/slice metadata.
- Replace incompatible large-file, attachment, email-body, and document pagination DTOs with one small `ReadSlice` envelope.
- Replace duplicated truncation in action-result and planner serializers with one prompt projection stage.
- Reuse document storage, connector services, media metadata/byte storage where its current lifecycle is appropriate, background-shell offsets, and trajectories. Do not treat the current pre-auth/FIFO media store as durable private tool-output storage without redesign.
- Keep source parsers separate, but make navigation and proof uniform.
- Avoid an initial distributed retrieval framework or generic CONTENT action. V1 needs bounded native reads, exact continuation, central projection, and telemetry.
- Avoid mandatory LLM summaries. Deterministic structure is cheaper, reproducible, and available during provider failure.
- Avoid migrating every cap at once. Classify caps, build recoverability centrally, then convert destructive sites.

## Testing strategy

### Test layers and what each proves

| Layer | Harness | Required proof |
| --- | --- | --- |
| Pure unit | Vitest in owning packages | Reference/range validation, budget math, Unicode boundaries, serializer non-duplication, fair-share allocation |
| Seeded property/fuzz | Repository seeded PRNG pattern | No gaps/overlap, stable round trips, arbitrary chunking, hostile shapes, deterministic replay |
| Adapter contract | Shared conformance suite | Every adapter implements exact slice/offset/revision and typed failures consistently |
| Real persistence integration | PGLite/temp filesystem/loopback connector | Transactions/auth/indexes in PGLite; restart/readback in a fresh child process over an explicit state directory; cleanup |
| Deterministic action scenario | Scenario runner, model-free direct turns | Production handlers return exact late pages, revisions, typed denials, and one text carrier |
| Deterministic planning scenario | Scenario runner with strict fixture model | Agent sees partial marker, calls next/search, and answers from late evidence without canary leakage |
| Isolated scenario | `test:scenarios:isolated` | No cross-scenario memory, handle, cache, or embedding leakage |
| Live-model scenario | Credentialed scheduled lane | Multiple model families reliably discover and use continuation without prompt coaching |
| API/UI E2E | Real local stack plus Playwright | Upload/email/document flow, visible partial state, context inspector, later retrieval |
| Soak/load | Separate benchmark process | Stable RSS/heap, bounded open handles, no latency drift, cleanup/retention |
| Evidence review | Existing evidence bundle pipeline | Exact-revision trajectories, reports, logs, screenshots/video, metrics and failures |

Unit tests alone cannot prove agent behavior. Live-model tests alone cannot prove losslessness or determinism. Both are required.

### Generated corpus

Extend the existing `@elizaos/corpus-tools` ownership boundary with a deterministic progressive-content generator and checked-in manifest schema, not a repository full of giant blobs. Generate into a temporary run directory and record SHA-256 plus planted-answer coordinates. Large writers and loaders must stream; the current corpus loader's whole-shard materialization cannot be the scale path being benchmarked.

The corpus has two explicit layers. The source/oracle manifest defines deterministic bytes, relations, canaries, revisions, and expected scopes. A native-realization layer consumes that manifest, seeds production services/APIs, and emits a ledger mapping every corpus object ID to its native reference, revision, authorization scope, extraction status, and cleanup identity. Filesystem family labels alone do not prove a memory row, document service, media attachment, Gmail adapter, or private artifact path.

Content families:

- Text/code: 0 B, 1 B, exactly-at-limit, limit ±1, 256 KiB ±1, 1 MiB, 10 MiB, CRLF/LF, no final newline, sparse and dense matches.
- Pathological lines: 1 KiB, 10 KiB, 100 KiB, and multi-megabyte single lines; minified JSON; escaped JSON containing newlines.
- Unicode: ASCII, CJK, Arabic/RTL, combining marks, emoji/ZWJ, flags, variation selectors, lone-surrogate inputs at JS boundaries, and invalid UTF-8 bytes.
- Documents: Markdown with headings, source code symbols, HTML, PDFs with text on early/middle/last pages, scanned/OCR pages, tables, footnotes, and mixed rotations.
- Email: long plain/HTML alternatives, quoted history, nested multipart, inline images, 0/1/many attachments, large thread, encoded headers, revoked scopes.
- Attachments/media: large transcript with target at late timestamp, multiple large attachments with target only in the last item, extraction pending/failure.
- Memories: thousands of room-scoped records, large fields, conflicting facts, near-duplicates, cross-room decoys, aged memories, post-compaction references.
- Tool output: interleaved stdout/stderr, no newline, huge line, binary bytes, progress rewrites, output beyond capture limit, process restart.
- Adversarial: prompt injection only in late page, archive bombs/oversized MIME trees within safe synthetic bounds, symlink/path mutation, offset/revision tampering, and stale generation.

Every generated object contains multiple canaries:

- A unique fact near the beginning, exact boundary, middle, and end.
- A decoy with similar wording.
- A source-coordinate oracle.
- A checksum oracle.
- An expected authorization scope.

Generation tiers:

| Profile | Default scale | Lane |
| --- | --- | --- |
| `micro` | 20 objects, under 2 MiB | Unit/property |
| `pr` | 64 files/docs, 2K memories, 128 emails, 32 attachments, 25–50 MiB | Required deterministic PR |
| `nightly` | 5K content objects, 100K memories, 10K emails, 2K attachments, about 1 GiB | Scheduled integration/performance |
| `release` | 50K objects, 1M memories, 100K emails, 10 GiB logical content | Pinned-host release |
| `soak` | Six hours and at least 100K mixed operations | Dedicated runner |

The v2 manifest records schema version, generator revision, root seed, fixed anchor time, resolved profile, publication contract, per-object coordinate system/revision/scope, format extraction normalization, logical bytes including format fixtures, and manifest SHA-256. Family seeds/IDs derive independently from the schema, root seed, family, and index; benchmark mode never uses `randomUUID`. MIME boundaries, archive timestamps, PDF structure, attachment payloads, revisions, and mutations are deterministic. Publication uses owner-only temporary files, no-follow/exclusive creation, atomic rename, prior-manifest-scoped stale-file sweeping, unsafe-mode rejection, and manifest-last verification. Sparse files are valid only for filesystem I/O tests; parser, extraction, search, semantic, and reassembly evidence uses fully generated streamed bytes.

The mechanically verified minimal format set is Markdown, HTML without script/style text, quoted CSV, canonicalized JSONL, a three-page text PDF, a heading-and-table DOCX, nested multipart MIME with a skipped attachment, an image-only PDF classified `ocr-required`, and an unsupported binary classified `failed`. These are corpus-extractor goldens, not proof of each production adapter. XLSX/sheet ranges, encrypted/malformed/pending files, production OCR output, and the broader PDF/DOCX/MIME matrix above remain required.

Mandatory mechanical oracles include full traversal SHA reassembly; no gaps or duplicates; exact search postings/ranges and decoys; before/after revision hashes; absence of unauthorized bytes from results, prompts, trajectories, logs, caches, and inspector output; absence of full-body duplication; fair minimum identity/retrievability for every item; and cleanup back to declared DB/disk/cache/FD/stream baselines. Deterministic model fixtures may choose actions but may not contain planted answers or canary text.

### Required behavioral scenarios

1. Read a late-file fact past the old 256 KiB barrier.
2. Search then expand around a late document fragment.
3. Triage an email from a snippet, then fetch its body and a related attachment.
4. Compare facts split across three attachments without the first starving the others.
5. Recover a failing test's root cause from externalized tool output.
6. Continue after compaction and reread a previously referenced range.
7. Detect source mutation between pages and restat/replan.
8. Refuse a continued read after scope revocation.
9. Navigate a one-line large JSON object without malformed/truncated evidence.
10. Resist instructions planted only in a later external-content page.
11. Handle extraction pending/failure, then succeed after extraction becomes ready.
12. Demonstrate room isolation with a tempting cross-room decoy.

Each deterministic scenario must assert the action arguments/ranges, not merely final prose. Each live scenario stores the full trajectory and uses an independent judge plus exact canary checks.

### Fault matrix

Inject faults at resolve, authorize, stat, read, search, extraction, persistence, continuation validation, database commit, connector refresh, compaction, and cleanup. Cover timeout/cancellation, short read, mid-page error, stat/read TOCTOU, metadata/body split-brain, concurrent delete/replace, index lag, client disconnect/backpressure, decompression/OCR bomb, corrupted manifest, cleanup/read race, process death, stale revision, digest mismatch, provider 401/403/404/409/429/5xx, disk full, and retention expiry.

The oracle is fail-explicit behavior: no fabricated completeness, no shifted continuation, no unauthorized fallback, and no tail loss mislabeled as recoverable.

Concurrency cases include many readers at one revision; writer/continuation races; authorization revocation mid-stream; deduplicated publication races; compaction racing reads; cleanup/expiry racing active readers; cancellation during I/O; and retry idempotence. Assert no shifted content, duplicate artifacts, leaked descriptors, or stale authorization-cache use.

## Performance and memory measurement

### Metrics

- End-to-end turn latency: p50/p95/p99.
- Time to first useful view and time to planted-answer recovery.
- `stat`, `read`, `search`, authorization, extraction, serialization, and model-stage latency.
- Bytes read from source versus bytes returned.
- Serialized prompt tokens per source and total.
- Number of model/tool round trips and repeated/no-progress reads.
- RSS, heap used, external memory, and peak delta per operation/turn.
- Array buffers, user/system CPU, event-loop delay, GC count and pause time.
- Open file descriptors/streams and leaked temporary artifacts.
- Database query count/duration, rows examined/returned, pool wait, table/index size, and WAL bytes where available.
- Filesystem bytes read/written; canonical, extracted, index, and cache bytes; deduplication ratio.
- Cache hit/miss and re-embedding/re-extraction work.
- Throughput, MiB/pages/fragments per second, and queue latency at concurrency 1, 8, 32, and 64.
- Prompt amplification: final serialized prompt tokens divided by returned source tokens.
- Cost per successful recovered canary for live lanes.

### Benchmark methodology

- Run benchmarks in fresh child processes so peak RSS and cleanup can be measured and PGLite lifecycle constraints do not contaminate results.
- Warm and cold runs are separate.
- Pin corpus seed, runtime/model configuration, revision, machine class, and concurrency.
- Record distributions, not averages alone.
- Compare against the previous accepted baseline; do not hard-code speculative universal milliseconds in the initial PR.
- Establish budgets after at least five stable repetitions on a pinned CI host. Report p99 only with at least 1,000 measured local operations; otherwise label it insufficient-sample.

The second pass identified two measurement corrections. The measured child currently retains its generated source buffer, so it cannot prove source-size-independent RSS; scale runs must generate/write outside the measured reader process or release the generator buffer before the baseline sample. Also, a 1,000-operation run leaves 999 warm samples after separating the cold sample, while the current percentile helper reports null below 1,000. Percentiles must be defined for every nonempty sample set, and the report must record cold sample count separately from warm p50/p95/p99.

| Lane | Required proof |
| --- | --- |
| PR deterministic | Contract/property/conformance tests, tiny real-format goldens, PGLite, strict fixture planner, mutation catalog, source-I/O counters |
| Post-merge | Fresh-process restart/readback, real local API/UI, generated medium corpus, concurrency 1/8/32/64, five pinned benchmark repetitions |
| Nightly/release | Real Postgres, full format/extraction shards, provider-qualified live models, fault/concurrency matrix, storage/cleanup evidence |
| Scheduled soak | At least six hours and at least 100,000 mixed operations, positive leaking control, RSS/heap/external/FD/DB/WAL series, abort/revoke/mutate/restart/expire cycles |

Every lane records generator schema/revision/seed/manifest SHA, exact commit, runtime versions, machine/OS/CPU/RAM, database/provider, sample count, concurrency, warm/cold state, latency distribution, throughput, memory series, source bytes, serialized bytes, cleanup inventory, and failures. A selected live lane treats missing credentials as failure, while keyless PR lanes remain deterministic and provider-free.
- PR gates catch large regressions; nightly lanes use tighter statistical comparisons and larger corpora.

Initial invariant budgets, which are architecture-independent:

- A 10 MiB ranged file read must not allocate or read approximately 10 MiB to return a small page.
- A 64 KiB byte page from a 10 MiB source reads at most 128 KiB including bounded lookahead; full sequential traversal reads no more than source size plus two page buffers and never rescans quadratically.
- Peak memory must scale with page/stream buffer size, not source size.
- Prompt tokens must remain below the computed budget after final serialization.
- Repeated paging must cover the source exactly once without gaps or overlap.
- Externalization must not add more than one durable copy of identical content.
- Cleanup returns handles/files/DB rows to the expected retention baseline.

Initial measurement gates for ratcheting on pinned hosts:

- Across 1, 10, and 100 MiB sources, peak RSS spread for the same page is at most `max(16 MiB, 4 × page size)` and external/array-buffer spread is at most `max(2 MiB, 4 × page size)`; generate source bytes outside the measured reader.
- Pure database reads perform no application DML, use a constant query count per page, return and examine bounded rows, and show an indexed seek plan. Measure and attribute WAL deltas rather than assuming PostgreSQL emits none. Warm late-page p95 for 100 MiB is no more than twice the 10 MiB result before tighter baselines exist.
- After five pinned-host repetitions, p95 latency—and p99 only with at least 1,000 measured warm samples—is at most `max(1.25 × accepted baseline, baseline + measured noise band)`, throughput is at least 80% of baseline, and peak memory is at most baseline plus `max(10%, 16 MiB)`.
- Soak executes at least six hours and at least 100,000 mixed operations. After warm-up, RSS/heap/external p95 drift is at most `max(5%, 16 MiB)`; FD/temp/row deltas are zero. A deliberately leaking positive control must fail the detector.
- Percentiles are calculated for every nonempty sample set, but p99 is labeled authoritative only with at least 1,000 measured warm samples.

## Existing harness integration

- Use `packages/scenario-runner` as the canonical real-runtime behavior harness.
- Add content seeds or custom seed helpers that generate files/documents/messages through real APIs, then capture handles and canary metadata in scenario context.
- Extend final checks for content reads, ranges, stale-revision failures, prompt-budget telemetry, and post-compaction readback.
- Use strict deterministic model fixtures for PR behavior. No heuristic fallback.
- Run isolation-sensitive scenarios through `packages/scripts/run-scenarios-isolated.mjs`; the ordinary CLI intentionally shares one runtime.
- Add scenario reports, trajectories, benchmark JSON, heap/RSS summaries, and UI recordings through the existing evidence bundle architecture rather than a separate evidence system.
- Add one named `reports/content-context/` producer/ingestor with an ingestor regression test; the evidence package deliberately does not scan arbitrary roots.
- Add `packages/scripts/run-content-context.mjs` as one named producer coordinator invoked by `test:matrix:review`. It validates its declared corpus/realization/test/benchmark/UI sub-artifacts under the assigned run root and writes a strict completeness manifest. The existing matrix command remains the sole owner of pre-run inventory, producer execution, exact bundle creation, verification, and review; sub-producers do not create competing report roots or invoke evidence ingestion themselves.
- UI changes use the app's existing Playwright/audit and recording paths.
- Use PGLite in PR lanes and real Postgres for nightly/release scale evidence.

The isolated runner now uses per-run temporary directories, collision-free report paths, signal/timeout handling, argument forwarding, deterministic aggregation, and bounded worker concurrency. The scenario judge itself caps some serialized values, so exact content proof uses mechanical access/hash ledgers rather than the judge.

The existing real-LLM attachment smoke calls a provider with content already embedded and can skip cleanly without credentials. Do not count it as progressive-access proof; add real-runtime live scenarios that fail loudly when an explicitly selected live lane lacks its provider. Retain or remove the smoke independently based on its current provider-contract value.

## Rollout recommendation

1. Land the implemented internal `ReadSlice` contract, conformance tests, central budget accounting, telemetry, and bounded coding FILE I/O behind the opt-in feature flag.
2. Land corpus v2, then add its native-realization ledger and shared adapter conformance/mutant harness.
3. Complete fresh-process summary-manifest readback and run identical persistence semantics on PGLite and scheduled Postgres.
4. Replace repeated whole-parent work with indexed document/message/attachment segments and durable owner-bound attachment locators.
5. Replace process-local Gmail continuations with stable connector/body revisions and bounded private segments while retaining compact triage previews.
6. Move token projection to final provider request preparation and tune fair allocations from exact-head trajectories.
7. Design private tool-output spill only after authorization, retention, reference-aware GC, atomicity, and cleanup fault tests are accepted.
8. Add the redacted inspector, native autonomous/live scenarios, all-source performance/soak, one evidence coordinator, and explicit CI ownership before enabling projection by default.

Do not raise all constants as an interim fix. It increases memory, token cost, cache churn, and prompt-injection surface while leaving the tail inaccessible at the next threshold.

## Open questions with recommended answers

- **Should raw content always be retained?** Within existing retention/security policy, yes. Prompt omission is not storage deletion.
- **Should V1 include semantic summaries?** Optional. Deterministic outline plus exact reads is the reliable base.
- **Should locators/artifacts be globally durable?** No. They honor native source or private-artifact retention and authorization; revision/expiry is explicit.
- **Should the model be allowed to request the full object?** Yes when authorized and budgeted, but the runtime may deliver it as multiple exact pages.
- **Should test corpora be checked in?** Check in generators, manifests, tiny golden fixtures, and hashes; generate large payloads in run directories.
- **Should performance gates use fixed latency numbers immediately?** No. First land invariant bounds and telemetry, then ratchet from stable CI baselines.
- **Should scenario expansion generate every size × encoding × source combination?** No. Use pairwise coverage in PR, targeted full Cartesian shards post-merge/nightly, and seeded randomized cases.
- **Should live-model success be the primary gate?** No. Deterministic contract gates are primary; scheduled live-model trajectories prove planning robustness across models.

Core live-model behaviors run at least five times. Authorization and prompt-injection cases require 5/5; all lanes report exact-answer and continuation-discovery rates, tool/no-progress read counts, latency, tokens, and cost. Soak sampling excludes warm-up, samples every 1,000 operations, forces GC only in controlled Node lanes, includes a positive leaking control, and cycles abort, mutation, revocation, compaction, restart, expiry, and eviction.

## Conclusion

The clean v1 is smaller than both the current one-off limits and a new universal content framework: native actions and authorization, one slice envelope, one prompt projection stage, one telemetry vocabulary, one corpus, and one conformance suite. The system remains bounded, but content remains recoverable. A universal dispatcher or handle can be reconsidered later from real adapter and trajectory evidence.
