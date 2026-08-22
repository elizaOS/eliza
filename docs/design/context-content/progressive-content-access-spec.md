# Progressive content access specification

Status: core contracts, bounded FILE reads, model-input accounting, archive/reference
support, and corpus v2 are merged; prompt-integrity correction, bounded native
DOCUMENT reads, and durable continuity are active

Date: 2026-08-22

Owners: core runtime, agent host, coding tools, documents, connector adapters,
scenario runner, evidence, and training/evaluation pipelines

Tracking: [#24286](https://github.com/elizaOS/eliza/issues/24286) and
[#24592](https://github.com/elizaOS/eliza/issues/24592)

## 1. Objective

elizaOS must inspect large authorized files, emails, attachments, documents,
memories, and tool outputs without silently discarding model context or requiring
whole-source work for every small read.

Progressive content access is an explicit retrieval contract. A caller requests a
bounded page, receives that exact page plus machine-readable continuation state,
and may request another page later. Once content is selected for a model call,
prompt construction, provider output, action/tool results, conversation history,
evaluator input, model output, and training rows remain complete.

The governing rules are:

> A caller-requested source page may be partial. The model request assembled from
> that page and all other selected context may not be silently partial.

> Dispatch the complete final serialized request only when it fits the selected
> provider/model boundary. Otherwise reject before provider dispatch with a typed,
> actionable error and preserve complete protected diagnostic evidence.

This design uses elizaOS native actions, authorization, memory/database contracts,
document and media ownership, planner/evaluator paths, trajectories, scenarios,
and evidence bundles. It does not adopt another framework or create a universal
content store.

## 2. Scope and non-goals

In scope:

- Bounded, exact reads for FILE, DOCUMENT, ATTACHMENT, email/message, memory,
  and SHELL/tool-result sources.
- Source-backed references, ranges, revisions, continuation, and reassembly.
- Complete planner, evaluator, action/tool, history, provider, and training
  serialization with pre-dispatch size rejection.
- Durable, explicitly readable continuity records that survive restart without
  being injected into summaries or model context.
- Authorization, isolation, mutation, performance, memory, database, cleanup,
  scenario, E2E, live-model, and evidence proof.

Non-goals:

- Creating a second attachment or byte store, a `files` table, reference counting,
  a second garbage collector, or a `fileId` field on `Media`.
- Automatically filling a 1M-token window.
- Summarizing, compacting, truncating, slicing, taking a recent window, limiting
  item count, or omitting selected model-facing content to make a request fit.
- Reintroducing conversation compaction or `/compact`.
- Treating vector search, a preview, or a summary as authoritative content.
- Replacing established native actions with a generic CONTENT action in v1.

## 3. Design principles

1. **Complete model input.** Every selected model-facing field and item is
   serialized in stable order without hidden caps, omission, summary, or windows.
2. **Reject before dispatch.** Measure the complete final provider payload. If it
   cannot be accepted, do not call the provider; return a typed error naming the
   measured size, supported limit, model/provider, and safe recovery choices.
3. **Explicit pagination only.** Paging occurs only because the caller requested a
   bounded native read. A partial page identifies itself as partial and provides a
   clear continuation; it is never presented as the complete source.
4. **One slice contract, native adapters.** Sources share range and continuation
   semantics while retaining native identities, storage, units, and authorization.
5. **Exact reads under navigation.** Metadata, search, and optional summaries may
   help choose a source, but claims resolve to exact authorized ranges.
6. **Authorization on every read.** A reference is not ambient authority. Resolve
   it again under current room/world/owner/connector and retention policy.
7. **Revision-bound continuation.** A changed source returns a typed stale-source
   conflict rather than shifted content.
8. **Durable continuity without prompt injection.** A content-free head and
   immutable bounded shards preserve the complete logical access ledger. They are
   read only through an explicit authorized operation.
9. **Bound source work.** A small result is insufficient if the adapter still
   fetches, decodes, scans, hashes, or allocates the complete source for each page.
10. **One authoritative carrier.** Runtime-only data may remain structured, but
    serializers must not duplicate or replace selected model content through an
    alternate field.
11. **Training integrity.** A trainer with a smaller sequence boundary rejects the
    complete row. It never trains on an unrecorded prefix, suffix, summary, or
    compacted variant.

## 4. Minimal v1 contracts

### 4.1 Native locator and model-safe reference

Each adapter retains its native runtime-only locator behind its authorization
boundary. The model-safe reference is a redacted resolution token:

```ts
interface ContentReference {
  kind: "file" | "document" | "attachment" | "email" | "memory" | "tool-result";
  ref: string;
  revision?: string;
}
```

`ref` reveals no raw path, account ID, provider token, or cross-room identifier.
References are classified internally:

- **Restart-safe:** a fresh process can resolve and reauthorize it.
- **Session-safe:** current-process/session state is required.
- **Non-resumable:** the upstream source is already lost; no continuation is
  offered and the result says `partial-source-loss`.

Only restart-safe references may enter durable continuity shards.

### 4.2 Shared `ReadSlice`

```ts
interface ReadSlice {
  range: {
    unit: "line" | "fragment" | "byte";
    start: number; // inclusive, zero-based
    end: number;   // exclusive
    total?: number;
  };
  hasPrevious: boolean;
  hasMore: boolean;
  nextOffset?: number;
  revision?: string;
  completeness:
    | "complete"
    | "partial-recoverable"
    | "partial-source-loss"
    | "unavailable";
  sliceSha256: string;
  sourceSha256?: string;
  reason?: string;
}

interface ReadView {
  reference: ContentReference;
  slice: ReadSlice;
}
```

The returned page text is canonical source content. Rendering may surround it
with metadata but may not cut or rewrite it. `nextOffset` exists only for
`partial-recoverable`, equals `range.end`, and advances. Empty sources return
`[0,0)`. At one revision, sequential pages reconstruct the normalized source
exactly once without gaps or overlap. UTF-8 and JavaScript UTF-16 boundaries
never emit malformed text or skip/duplicate code points.

### 4.3 Explicit operation shape

V1 keeps current action names and adds compatible paging arguments:

```text
FILE action=read file_path [offset] [limit] [unit] [expectedRevision]
DOCUMENT action=read documentId [offset] [limit] [unit] [expectedRevision]
ATTACHMENT action=read attachmentId [offset] [limit] [expectedRevision]
provider email/message read accountId messageId [offset] [limit] [expectedRevision]
```

The presence of `offset`/`limit` is a caller request for pagination. The action
result reports exact range, total when known, completeness, and continuation.
Search remains domain-owned and returns exact readable ranges only when its index
uses the same coordinate system as the native reader.

## 5. Complete serialization and pre-dispatch rejection

### 5.1 Final-wire authority

There is one acceptance point immediately before provider dispatch. It receives
the complete request after tool schemas, system/user messages, history, action and
tool results, evaluator material, wrappers, and provider-specific serialization
are final.

The acceptance point:

1. Serializes the exact payload that would be dispatched.
2. Measures with the provider/model tokenizer when available and a conservative,
   versioned estimator otherwise.
3. Accounts for the provider's advertised input boundary and required output
   reserve without altering the input.
4. Dispatches the payload unchanged when it fits.
5. Otherwise throws a typed `ElizaError` before any provider call.

The error contains an actionable code, measured tokens/bytes, supported limit,
reserve, model/provider identity, and recovery guidance such as requesting a
smaller source page or starting a deliberately narrower task. It contains no raw
secrets or unauthorized content.

No feature flag, provider failover path, legacy formatter, evaluator retry,
message-state builder, reflection path, grounded action reply, training exporter,
or compatibility layer may re-enable omission, summary, compaction, recent-only
history, item limits, or prefix/suffix cuts. Failover may rerender provider syntax,
but it must carry the same complete logical content and repeat the final-wire check.

### 5.2 `ActionResult` integration

- `text` contains the complete caller-requested page or complete small result.
- `promptData` may provide the canonical model-facing structured representation.
- When `promptData` replaces runtime-only `data`, every model-relevant field from
  the declared model contract must be present; this is a schema choice, not a
  budget-driven deletion.
- `data` must not cause the same source body to be serialized a second time.
- Error text and structured failures are complete.
- Result order and field order remain deterministic and testable.

### 5.3 Protected rejection trajectory

An over-boundary attempt records a protected, access-controlled trajectory event
that proves what happened without creating a second public content leak. The event
binds the complete prepared-request digest, serialization/schema version, ordered
message/result counts, measured tokens/bytes, provider/model limit, reserve, error
code, and dispatch-attempt count (`0`). When policy permits protected raw request
capture, it must be the exact complete rejected request. Otherwise the original
authorized sources remain the content authority and the digest plus structural
metadata proves identity; no truncated diagnostic copy is substituted.

Production logs and ordinary telemetry remain content-free.

## 6. Native source adapters

### 6.1 Coding files

- Use positioned reads with bounded lookahead; do not call whole-file `readFile`
  before returning a page.
- Support byte mode for minified files and multi-megabyte lines.
- Bind continuation to stat generation and digest/version when available.
- Reject binary-as-text explicitly while preserving an authorized parser path.

### 6.2 Tool and process output

- Record stdout/stderr, exit state, source byte/line counts, and upstream loss
  independently.
- Preserve complete ephemeral output only through an approved private lifecycle
  with authorization, retention, atomic publication, redaction, reference-aware
  GC, and cleanup proof.
- Until that lifecycle exists, fail explicitly before discarding source output.
- Never label an upstream capture cap as recoverable pagination.

### 6.3 Documents

- Reuse current document storage and media ownership; do not add a parallel store.
- Store large canonical text as immutable, non-overlapping UTF-8 byte segments
  indexed by document, revision, ordinal, start, and end.
- Select intersecting segments plus bounded lookahead. Embedding chunks are derived
  search views, not the exact paging authority.
- Reindex legacy unsegmented large documents transactionally or return typed
  `DOCUMENT_REINDEX_REQUIRED`; do not repeatedly scan/hash the parent JSON value.

### 6.4 Email and attachments

- A triage list may be explicitly named and rendered as a preview, provided its
  complete body is never passed later as model context under that preview label.
- Body reads use stable account/message/revision coordinates, bounded private
  segments after limited acquisition, and current connector authorization.
- Attachment locators bind the owner/message and reauthorize before resolving
  immutable extracted-text segments.
- Process-local random tokens are session-safe and never enter durable shards.

### 6.5 Memories and database records

- Small structured memories remain complete when selected for a model request.
- Large source fields remain native and are accessed through explicit pages.
- Retrieval and continuity reads recheck room/world/owner scope.
- Semantic recall points to exact source references and ranges rather than storing
  a cut copy as if it were the original memory.

## 7. Durable explicit continuity ledger

There is no automatic conversation compaction, `/compact`, LLM summary injection,
session-summary metadata carrier, or automatic model-context restoration in this
design.

Continuity is a content-free, authorized data structure in the existing
memory/database domain:

```ts
interface ContentAccessLedgerHead {
  schemaVersion: 1;
  ownerScope: string;
  firstShardRef?: string;
  lastShardRef?: string;
  entryCount: number;
  ledgerSha256: string;
  generation: string;
}

interface ContentAccessLedgerShard {
  schemaVersion: 1;
  ordinal: number;
  previousShardRef?: string;
  nextShardRef?: string;
  entries: Array<{
    reference: ContentReference;
    rangesUsed: Array<{
      unit: ReadSlice["range"]["unit"];
      start: number;
      end: number;
    }>;
    lastUsedAt: string;
  }>;
  shardSha256: string;
}
```

The head is small and content-free. Shards are immutable and individually bounded;
overflow appends another ordered shard. The logical ledger has no count or byte
ceiling that drops references/ranges. Publication is atomic and concurrent writers
cannot lose disjoint entries. Every link, ordinal, digest, schema, scope, and entry
is validated. Broken, missing, repeated, reordered, cyclic, or digest-mismatched
chains fail explicitly.

The ledger is never automatically placed in a prompt, summary, history, provider
request, or evaluator input. A caller may explicitly request an authorized ledger
page, which is then subject to the same exact paging and complete-request rules.
Reading an entry does not grant source access; the native source reauthorizes it.

Acceptance requires count rollover, byte rollover, repeated rollover, serialization
pressure, concurrent disjoint writers, writer-process termination, fresh child
process readback over PGLite, complete ordered traversal, late-canary reread through
production actions, and the same semantic vectors on scheduled real Postgres.

## 8. Security and failure semantics

- Reauthorize every source and ledger operation; expiry and revocation are visible.
- References expose no path, account, provider credential, or cross-scope ID.
- Stale revision, malformed cursor, unsafe range, extraction failure, source loss,
  reindex requirement, oversize final request, and unavailable private persistence
  are distinct typed errors.
- Resolve/stat/read TOCTOU cannot produce a falsely complete page.
- Prompt-injection defenses apply to every explicitly loaded page.
- UI previews and log summaries are clearly named and never reused as model input.
- A rejected request has zero provider dispatch attempts and no fallback that sends
  a partial payload.

## 9. Telemetry and evidence

Production telemetry is content-free and records:

- Complete prepared-request token/byte measurements and limit/reserve.
- Dispatch or typed rejection outcome and error code.
- Ordered message/action/tool-result counts and serializer version.
- Provider/model identity under existing privacy policy.
- Native read kind, requested/returned range sizes, latency, I/O counters, and
  typed failures where privacy review permits.

It does not report "included" versus "omitted" model pages because omission is not
an allowed prompt behavior. Protected evidence binds exact request/source hashes,
full trajectories where authorized, corpus revision, access ledger, source I/O,
benchmarks, memory/FD series, cleanup, scenario reports, E2E artifacts, and bundle
integrity at the same commit.

## 10. Acceptance contract

The feature is not complete until all of the following are demonstrated:

- Every model-facing serializer preserves complete selected prompt, action/tool,
  history, evaluator, provider, output, and training content in stable order.
- A complete final request that fits is dispatched byte-for-byte; one that does
  not fit returns a typed actionable error before provider invocation.
- Feature flags and provider fallback cannot re-enable hidden content loss.
- Caller-requested pages identify partialness and reassemble exactly without gaps,
  duplicates, malformed Unicode, or false completeness.
- Late facts are found in FILE, DOCUMENT, email, attachment, memory, and tool
  output through production native actions.
- Small pages have bounded I/O, allocation, query count, and rows examined across
  increasing source sizes.
- Source mutation and authorization revocation fail explicitly.
- Durable continuity recovers every ordered entry/range after rollover, concurrent
  writes, and fresh-process restart, without automatic model injection.
- Unauthorized bytes are absent from prompts, trajectories, logs, caches, UI,
  and continuity records.
- Deterministic scenarios, provider-qualified live scenarios, real-stack E2E,
  PGLite/Postgres conformance, performance, soak, evidence integrity, exact-head
  repository gates, and hosted CI pass.

### 10.1 Required mutants

The checked-in mutant registry must execute and kill every required mutant,
including:

- Restore whole-source materialization or repeated parent scan/hash/refetch.
- Drop expected-revision or continuation authorization validation.
- Split UTF-8/UTF-16 incorrectly, skip/duplicate a middle page, or falsely report
  completeness.
- Re-enable an item cap, recent window, prefix/suffix cut, summary, compaction,
  omission flag, or compatibility formatter that discards model content.
- Measure before final serialization, skip the oversize check, send the oversize
  request anyway, or call a fallback provider with partial input.
- Duplicate source content through `data`, `promptData`, or another carrier.
- Replace ledger shards with omission counters, lose a concurrent writer, or
  break/skip/repeat/reorder/cycle a shard link or digest.
- Convert missing credentials in a selected live lane into a skip.

### 10.2 Scenario and performance proof

Required scenarios cover late evidence, multi-item reads, huge single lines,
stale revisions, revocation, extraction pending/failure, restart, adversarial late
instructions, explicit ledger browsing, final-wire rejection, and complete
successful dispatch. They assert tool arguments/ranges and exact canary provenance,
not only final prose.

Benchmarks record p50/p95/p99 with sample qualification, throughput, source bytes,
serialized request bytes/tokens, RSS/heap/external/array buffers, CPU/event-loop/GC,
FD/streams, DB queries/rows/plan/WAL, storage/cache growth, concurrency 1/8/32/64,
cleanup, and cost per recovered canary. Peak resource use for the same page must
scale with page/stream buffers rather than source size. Soak runs for at least six
hours and 100,000 mixed operations with a positive leaking control.

## 11. Current delivery status and merge order

Merged foundations:

- [#24305](https://github.com/elizaOS/eliza/pull/24305): shared progressive
  content contracts and bounded native foundations.
- [#24345](https://github.com/elizaOS/eliza/pull/24345): archive/reference-related
  follow-up.
- [#24521](https://github.com/elizaOS/eliza/pull/24521): refreshed design,
  corpus, scenario, and evidence foundation.
- [#24496](https://github.com/elizaOS/eliza/pull/24496): deterministic corpus v2.

Closed designs not to revive:

- [#24498](https://github.com/elizaOS/eliza/pull/24498): rejected because capped
  canonical rollover lost references/ranges and summary metadata was the wrong
  carrier.
- [#24387](https://github.com/elizaOS/eliza/pull/24387): closed continuity attempt.

Active work:

1. [#24592](https://github.com/elizaOS/eliza/issues/24592): remove prompt
   projection/omission paths and enforce complete final-wire serialization with
   typed rejection.
2. Truly bounded native DOCUMENT segments and adapter conformance.
3. Content-free head plus immutable, lossless continuity shards with restart and
   concurrency proof.
4. Native corpus realization, full mutant/fault/scenario/E2E/Postgres/performance/
   soak evidence, and final truncation-inventory disposition.

## 12. Recommended decisions

- Fixed 10K cap as model content: **no**.
- Complete caller-requested page plus explicit continuation: **yes**.
- Automatically reduce selected context to fit: **no; reject before dispatch**.
- Automatically fill a 1M context: **no**.
- Summaries as authority or fit mechanism: **no**.
- Automatic compaction or `/compact`: **no**.
- Durable continuity automatically injected into prompts: **no; explicit reads**.
- One physical segmentation for all sources: **no; share only the slice envelope**.
- Separate source stores: **no; preserve native ownership and the media-store
  invariant**.
- Vector-only retrieval: **no; use search/navigation plus exact reads**.

## 13. Deferred decisions

- A generic CONTENT action and global content URI grammar.
- Signed external cursors for trusted internal action calls.
- Universal semantic outlines or cross-source relation graphs.
- Additional range units before stable native coordinate systems exist.
- Private automatic tool-output persistence before its complete lifecycle passes
  authorization, retention, atomicity, redaction, GC, fault, and cleanup review.
