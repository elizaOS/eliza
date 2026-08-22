# Progressive content access specification

Status: experimental implementation candidate; projection is opt-in; M4 follow-up under review

Date: 2026-08-21

Owners: core runtime, agent host, coding tools, documents, connector adapters, scenario runner, evidence

## 1. Objective

elizaOS must be able to work with large files, email bodies, attachments, documents, memories, and tool outputs without placing all source content in every model request and without irreversibly discarding content behind fixed character limits.

The system uses one small slice/continuation contract across its existing domain actions. Each source remains owned and authorized by its native service. Each model turn can receive a bounded projection appropriate to the active model and remaining context budget, and the agent can request additional exact ranges later. A future compaction/archive seam must preserve those references mechanically; this change does not restore the removed compaction subsystem.

The governing rule is:

> A prompt projection may be partial. The authoritative content must remain addressable, and partialness must be machine-readable.

This design does not copy another framework. It uses elizaOS's existing `ActionResult.promptData`, planner loop, model-input budget, memory/database contracts, document service, media metadata/store where appropriate, connector authorization, trajectories, scenario runner, and evidence bundles.

## 2. Scope and non-goals

In scope:

- Files available through coding tools or capability routers.
- Tool and subprocess output.
- Email messages, threads, MIME parts, and attachments.
- Conversation attachments and extracted media text.
- Stored documents and their existing chunks.
- Memories or database-backed records whose complete representation is too large for a prompt.
- Prompt projection, compaction survival, authorization, observability, and testing.

Non-goals:

- Creating a second attachment or byte store. The media-store invariant remains authoritative.
- Loading an entire object merely because a model advertises a 1M-token context window.
- Replacing exact content with an LLM summary.
- Treating vector search as a completeness guarantee.
- Removing transport, security, database, or display limits that intentionally fail closed.
- Replacing the established FILE, DOCUMENT, ATTACHMENT, email/message, and SHELL actions with a generic public action in v1.

## 3. Design principles

1. **Resolve before projecting.** Establish an authorized, later-resolvable native reference before projection. Persist first only when the source is ephemeral.
2. **One slice contract, native adapters.** Files, email, documents, attachments, memories, and tool output share range/continuation semantics while retaining their native actions, identifiers, units, and authorization.
3. **Exact reads under semantic navigation.** Summaries and search find likely evidence; exact ranges remain the authority.
4. **Explicit partialness.** Every incomplete view reports its range, unit, total when known, continuation, digest/version, and omission reason.
5. **Model-aware budgets.** Prompt budgets are token-based and account for wrappers and aggregate turn cost. Byte/character limits remain safety ceilings only.
6. **Authorization on every read.** A locator is not ambient authority. Native resolution rechecks the caller, room/world scope, connector grant, and retention state.
7. **Revision-bound continuation.** Internal offsets carry an expected revision. Changed content yields a typed stale-source conflict; external APIs may later wrap this state in opaque signed cursors.
8. **Mechanical future compaction state.** Any future compaction implementation must preserve references and ranges through a runtime-derived manifest, not through summarizer memory alone.
9. **No hidden duplication.** Prompt serializers use the bounded projection and must not serialize the full body again through `data`.
10. **Measure real behavior.** Acceptance includes whether agents request and use later content, not only whether an API supports pagination.

## 4. Minimal v1 model

### 4.1 Native locator and model-safe reference

V1 does not introduce a global URI grammar or copy authorization/lifecycle fields into a new public handle. Each adapter retains its native runtime-only locator—such as a validated path, document ID, or provider account/message ID—behind its authorization boundary.

Only this small opaque reference may enter `promptData`, trajectories, telemetry, or compaction:

```ts
interface ContentReference {
  kind: "file" | "document" | "attachment" | "email" | "memory" | "tool-result";
  ref: string;
  revision?: string;
}
```

`ref` is a redacted native-service token, not ambient authority. Every read resolves it through the domain's normal authorization. Raw paths, provider account IDs, and cross-room identifiers stay inside the adapter.

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

The exact returned source text remains only in `ActionResult.text`. It is not decorated with gutters/notices before hashing; callbacks and prompt serializers may render those around the canonical page. `ReadView` appears in `data` and `promptData`; complete bodies and raw locators do not. `nextOffset` is required and equals `range.end` only for `partial-recoverable`. `complete` implies `range.end === total` when total is known. `partial-source-loss` reports the upstream captured size/loss boundary. Mutable recoverable sources carry a revision and require `expectedRevision` on continuation; immutable sources carry digest/version identity. Signed opaque cursors are deferred for external HTTP boundaries.

Offsets/limits are nonnegative safe integers; overflow is rejected and limits are clamped. When total is known, `0 <= start <= end <= total`. `hasPrevious === (start > 0)`. `nextOffset` exists iff more recoverable source follows, equals `end`, and advances. Empty sources return `[0,0)`. At one revision, sequential slices reconstruct the normalized source exactly once without gaps or overlap. Byte reads decode only complete UTF-8 sequences; JavaScript slicing never emits malformed surrogates or skips/duplicates code points.

### 4.3 Future navigational views

V1 requires native exact paging. Layered summaries, universal outlines, semantic navigation, and a cross-source relation graph are future work. Existing domain metadata/search remain usable, but any hit used as evidence resolves to an exact model-safe reference and range.

## 5. Existing actions and operations

V1 keeps current model-facing action names and adds compatible parameters/results:

```text
FILE action=read file_path [offset] [limit] [expected_revision]
DOCUMENT action=read document_id [offset] [limit] [expected_revision]
ATTACHMENT action=read attachment_id [offset] [limit] [expected_revision]
provider email/message read account_id message_id [offset] [limit]
```

Search stays domain-owned. Search hits resolve to exact model-safe references/ranges. Page, MIME-part, sheet, or time selectors may remain domain-specific and map to a v1 line/fragment/byte slice. A generic CONTENT dispatcher, global URI, universal outline, and cross-source relation graph are deferred.

Requirements:

- A page read performs bounded I/O. Line paging must not call whole-file `readFile` first.
- `search` returns exact ranges only when the search index and native reader share the same coordinate system. Otherwise it returns the authorized parent reference plus ranking or media anchors and never invents readable coordinates or source completeness.
- A readback page from an externalized result retains the original artifact identity; it is not externalized again as a new unrelated object.

## 6. Prompt projection and budgets

### 6.1 Budget computation

Actions use conservative retrieval-page limits. The central projection layer uses the existing `buildModelInputBudget` result to decide what reaches a particular model request. Page sizing and prompt projection are separate: an action does not know the final tool-schema, history, reserve, or selected-model cost.
The actual inline allowance is the minimum of the remaining request capacity after reserves, the per-result budget, the aggregate per-turn content budget, and safety limits. Larger-context models can receive larger projections after measurement, but no independent “percentage of context” formula is embedded in each action.

Budgets are computed after final serialization, including JSON, line-number gutters, XML/fences, and omission notices. Tokenizer-backed counts are preferred; a model-family estimator is the fallback. Character count alone is not a prompt budget.

The current experimental implementation applies this policy to native trajectory planner/evaluator rendering. Legacy prompt builders that serialize `ActionResult` values directly must migrate to the same final-request projector before the feature can be described as central across all model-facing paths or enabled by default.

The M4 follow-up uses `renderActionResultsForModel` as the migration bridge for legacy prompt builders. When the rollout flag is enabled, ActionState, post-turn evaluation, reflection, message-state injection, and grounded action replies apply the same `promptData`-over-`data` rule and omit only validated recoverable pages. The legacy display formatter remains the disabled-rollout compatibility path. Native planner requests reject an over-budget post-projection request explicitly. Per-provider planner failover rerendering and tokenizer-backed final-wire counts remain rollout gates; the runtime must not truncate an opaque prompt after typed ActionResults have been serialized.

### 6.2 Per-result and aggregate policy

- Apply a per-result inline budget.
- Apply an aggregate budget across all tool results in one assistant turn.
- Reduce already-recoverable native sources to their reference/slice metadata first.
- Ephemeral output may be externalized only after the approved private artifact lifecycle exists; otherwise fail explicitly before dropping source content.
- Once private spill exists, reduce largest results first while retaining a small synopsis/reference for each.
- Fair-share multiple attachments/documents so one early object cannot consume the whole budget.
- Preserve control fields required by the planner even when content is externalized.

### 6.3 `ActionResult` integration

Rules:

- `text` is the page; `promptData` carries its model-safe reference/slice metadata and bounded structured values.
- `data` is structured control/result data, not a second carrier for complete bodies.
- When `promptData` exists, planner rendering must not fall back to or additionally serialize full `data` content.
- Full bodies remain in native sources or a specifically authorized private artifact store. SQL JSON limits remain fail-closed.
- The existing action-result omission marker is retained but enriched with a model-safe reference, range, and continuation.

## 7. Source adapters

### 7.1 Coding files

- Remove the source-size rejection from ranged text reads.
- Open/stat the file, read only the requested byte/line window, and return `nextOffset` plus revision.
- Support byte mode for minified files and pathological single lines, with well-formed incremental decoding.
- Bind continuation to stat generation plus content digest when available.
- Continue to reject binary-as-text, but return a model-safe reference for an authorized inspector/parser where available.

### 7.2 Tool and process output

- Stream output through bounded in-memory head/tail buffers. Preserve complete output through a private host-owned artifact interface only after its authorization, retention, GC, redaction, and atomicity contract is accepted.
- Record stdout/stderr independently, exit state, byte counts, line counts, and truncation before persistence.
- Background-process absolute offsets remain a valid adapter implementation.
- The current media store is not automatically that interface: it is agent-host owned, capability-URL readable, FIFO-evicted, and may leave broken references. Adapt its content-addressed byte layer; do not declare its current public media lifecycle durable for sensitive tool output.
- An upstream capture cap must be reported as irreversible source loss; it cannot be mislabeled as a recoverable prompt projection.

### 7.3 Documents

- Reuse current document storage and chunk embeddings.
- Exact reads support fragment, adjacent-fragment, line, and byte ranges. Parser page metadata may map a PDF page to exact text ranges, but a first-class page range unit remains deferred.
- Search returns document ID, fragment index/range, score components, and exact continuation.
- A pinned oversized document contributes at least identity metadata, a fair excerpt, and its model-safe reference; it may not disappear entirely because one block does not fit.

### 7.4 Email and attachments

- Inbox triage remains a compact envelope/snippet list.
- Every message exposes a model-safe body reference that later re-enters provider authorization for text ranges; existing thread and attachment IDs remain domain-owned selectors.
- Stored attachment text is paged independently; canonical media bytes remain governed by the existing media-store contract.
- Multiple items use fair per-item budgets.
- Revoked connector scopes fail explicitly on later reads.

### 7.5 Memories and database records

- Small structured memories remain inline.
- Large fields retain model-safe native references while the memory keeps typed metadata and provenance.
- Retrieval remains room/world/owner scoped.
- Semantic recall points to exact source ranges; it does not duplicate an arbitrarily truncated body into memory JSON.

## 8. Compaction and session continuity

Current `develop` no longer contains the former automatic conversation-compaction modules. V1 must not restore them as a side effect of progressive reads. The following manifest is the contract for any current archive/session-summary seam and for a future compaction implementation; native references already present in retained planner steps remain authoritative meanwhile.

Compaction produces two outputs:

1. An LLM-generated semantic summary.
2. A runtime-generated, schema-validated content manifest.

```ts
interface CompactionContentManifest {
  contentRefs: Array<{
    reference: ContentReference;
    revision?: string;
    reason: string;
    rangesUsed: Array<{ unit: ReadSlice["range"]["unit"]; start: number; end: number }>;
    lastUsedAt: string;
    retained: boolean;
    expiresAt?: string;
  }>;
  modifiedFiles: Array<{ reference: ContentReference; revision?: string }>;
  pendingProcesses: Array<{ id: string; outputReference?: ContentReference; offset?: number }>;
}
```

The runtime derives this from the access ledger and actual mutations. It is schema-validated, redacted, size-bounded, and authorization-covered. Recoverability must not depend on prose mentioning every reference.

The M4 follow-up introduces the versioned strict schema and a deterministic trajectory-derived snapshot across active and archived steps. The subsequent continuity slice stores it in the namespaced `metadata["elizaos:progressiveContent"]` envelope on the inbound dialogue memory before summary evaluation and on the assistant reply. Ordinary session summaries union the envelope without erasing unrelated metadata. Count, range, modified-file, pending-process, and 256 KiB serialized-byte pressure use deterministic rollover with explicit high-water counters; a new revision supersedes obsolete revision-bound ranges.

Persistence is limited to coordinates backed by current restart-capable,
authorization-enforcing resolvers: document and memory UUIDs and opaque
attachment coordinates. FILE, email/Gmail, and tool-result references remain
excluded until their durable resolver and retention contract exists. Manifest
derivation and persistence are best-effort diagnostics after planner effects:
their failure must never fail the completed reply or cause effect replay. The
envelope does not grant access, extend retention, restore removed automatic
compaction, or by itself prove restart durability. Fresh-process readback and
successful authorized resolution remain acceptance requirements.

## 9. Security and failure semantics

- Resolution rechecks authorization and SSRF/media policies on every operation.
- Model-safe references and external cursors must not expose filesystem paths, connector tokens, account IDs, or cross-room identifiers.
- Stale generation returns a typed conflict with fresh stat metadata.
- Ephemeral-output persistence failure before projection returns a typed error; native sources need not be copied.
- Extraction failure preserves bytes and exposes status, allowing another parser/OCR path later.
- Search/rerank failure leaves deterministic browse and exact reads available.
- Oversized single lines fall back to byte paging with incremental decoding.
- Aggregate exhaustion reduces recoverable native projections first. Ephemeral output fails explicitly if approved private spill is unavailable.
- Retention/expiry must be visible in `stat`; compaction cannot extend authorization or retention.
- Prompt-injection defenses apply to every late-loaded page exactly as they do to initial external content.

## 10. Telemetry contract

The v1 projection records a content-free aggregate for each model request:

- Whether projection was enabled and the result count.
- Baseline and remaining estimated request tokens.
- Per-result and aggregate estimated-token budgets.
- Included and omitted page counts.
- Numeric omission-reason counts.

It is attached to the existing structured log and model-call/trajectory metadata seams. It excludes raw content, source references, paths, IDs, provider/account metadata, and hashes. Adapter and benchmark lanes may record source kind, ranges, sizes, latency, I/O, memory, cache, and typed failures in their protected test artifacts; promoting those fields to production telemetry requires a separate privacy review.

## 11. Acceptance contract

The feature is not complete until all of the following are demonstrated:

- A file larger than 256 KiB can be read to its end through bounded pages without whole-file materialization.
- A fact placed only near the end of a large email, attachment, document, memory, and tool result is found and cited correctly.
- Multiple large attachments receive fair discovery and later reads.
- A single-line multi-megabyte JSON/log can be navigated losslessly.
- UTF-8 decoding and JavaScript UTF-16 slicing never emit malformed surrogates or skip/duplicate code points.
- Mutation between pages returns stale-source conflict rather than shifted content.
- Revoked authorization blocks later retrieval without leaking prior unseen content.
- Model-safe references/revisions remain usable across later turns while retention and access remain valid.
- Raw bodies are absent from prompt `data` when a bounded projection is present.
- Deterministic production-action scenario, evidence ingestion, and the invariant performance gate pass at the same revision.
- A scheduled live-model planning lane, context-inspector UI/API, fresh-process manifest readback, provider soak, and real-Postgres scale lane are follow-up rollout gates before enabling projection by default.

A future inspector exposes only redacted reference, kind, included range, completeness/omission reason, token budget/use, and retention state—never raw source text, paths, provider IDs, or unauthorized metadata.

### 11.1 Normative verification

Delivery requires shared adapter conformance and seeded property suites; temp-filesystem and real PGLite integration; fresh-child-process restart/readback; deterministic isolated scenarios; scheduled live/provider-qualified scenarios; real-stack API/UI E2E; authorization/fault/concurrency tests; performance/soak; and canonical evidence ingestion.

Behavioral acceptance tests must kill 100% of this explicit mutant catalog: restore whole-file materialization; drop expected-revision validation; split UTF-8/UTF-16 text incorrectly; falsely report completeness; omit a middle page; skip authorization on continuation; duplicate a body through `data`; let the first item starve others; budget before final serialization; reuse artifact identity incorrectly; or turn a selected live lane's missing credentials into a skip.

Required evidence includes corpus manifest/seed/SHA/coordinates, page access/hash ledger, final prompt-token ledger, source-I/O counters, mutant-kill report, fault report, benchmark/environment JSON, heap/RSS/external-memory/FD series, cleanup inventory, scenario report/native export/full trajectories, real E2E backend/browser/network/DB/artifact evidence, and bundle integrity result. The named producer must have a producer-to-bundle regression test and the exact bundle must be inspected.

## 12. Recommended decisions

- Retain raw content according to existing security/retention policy: **yes**.
- Use a fixed 10K-character cap: **only as an optional preview safety cap, never as the sole representation**.
- Fill a 1M-token window automatically: **no; increase adaptive pages and evidence breadth, but preserve retrieval discipline**.
- One chunk size for every source: **no; share the slice envelope, not the physical segmentation**.
- Separate source stores for files/email/documents: **no; use native source-backed adapters**. Private ephemeral-output metadata may adapt existing content-addressed byte primitives only after authorization, retention, and reference-aware GC are approved.
- Summaries as authority: **no; they are navigation aids**.
- Vector-only retrieval: **no; combine hierarchy, lexical/semantic search, and exact reads**.
- First implementation target: **shared `ReadSlice`, central prompt projection, and bounded FILE reads**. Private tool-output spill follows only after the host storage lifecycle is explicit.

## 13. Deferred decisions

- A generic CONTENT action and global content URI grammar.
- A universal public `ContentHandle` that duplicates native source metadata.
- Signed cursors for trusted internal action calls.
- New content database tables or a second byte store.
- Universal semantic outline/search/related operations.
- Page, MIME-part, sheet-range, and transcript-time units before stable native coordinates exist.
- Automatic spill of every large tool result before private authorization, retention, and reference-aware GC are solved.
