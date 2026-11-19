/** Foreground reads of reviewed original dialogue before reply processing or
 * effects. Original context events remain intact; only Stage-1 rendering changes. */

import type {
  ContextEvent,
  ContextObject,
  ContextObjectPromptSegment,
  JSONSchema,
  JsonValue,
  PromptSegment,
} from "@elizaos/core";
import {
  collectCompletionContextSources,
  completionContextSources,
  ElizaError,
  parseCompletionContextSelection,
  selectHistoricalNavigation,
} from "@elizaos/core";
import {
  type HistoryRetentionCheckpoint,
  type HistoryRetentionScope,
  includeLinkedSources,
  validateHistoryRetention,
  visibleHistoryEventIds,
} from "../../runtime/history-retention.ts";
import { readContextRequests } from "./context-discovery.ts";
import { labelHistorySources } from "./history-wire.ts";
import type { NativeHistoryReadBinding } from "./native-context-read.ts";

import {
  readSourceReplyReferences,
  sourceReplyEventHash,
} from "./source-reply-references.ts";

/** Match source-selection semantics to the supplied originals and available reads. */
export function withReviewedHistorySelection(
  schema: JSONSchema,
  nativeRead = false,
  repairSourceIds?: readonly string[],
): JSONSchema {
  const selection = schema.properties?.completionContext;
  const complete = selection?.properties?.complete;
  const mode = selection?.properties?.mode;
  if (!selection || !complete || !mode) return schema;
  return {
    ...schema,
    properties: {
      ...schema.properties,
      ...(nativeRead && schema.properties?.contextRequests
        ? {
            contextRequests: {
              ...schema.properties.contextRequests,
              enum: [[]],
              description:
                "No context reads accompany this final routing/reply decision. Use READ_CONTEXT first when authorized evidence is missing.",
            },
          }
        : {}),
      completionContext: {
        ...selection,
        properties: {
          ...selection.properties,
          ...(nativeRead && repairSourceIds
            ? Object.fromEntries(
                [
                  "relevantSourceIds",
                  "constraintSourceIds",
                  "referentSourceIds",
                  "pendingIntentSourceIds",
                ].map((name) => [
                  name,
                  {
                    ...selection.properties?.[name],
                    ...(repairSourceIds.length
                      ? {
                          items: { type: "string", enum: [...repairSourceIds] },
                        }
                      : { enum: [[]] }),
                  },
                ]),
              )
            : {}),
          mode: {
            ...mode,
            enum: ["relevant_prior_dialogue"],
            description: nativeRead
              ? "Select from supplied originals after resolving this request’s dialogue dependencies. Otherwise choose READ_CONTEXT, including history:all for exhaustive or unresolved history."
              : "Select from supplied originals. Request missing originals through contextRequests, including history:all for exhaustive or unresolved history. Keep complete=false while a dependency remains unresolved.",
          },
          complete: {
            ...complete,
            ...(nativeRead ? { enum: [true] } : {}),
            description:
              (nativeRead
                ? "HANDLE_RESPONSE certifies that this request’s dialogue dependencies are resolved from supplied originals. If any remain missing or uncertain, choose READ_CONTEXT instead; never certify unseen content."
                : "True only after reviewing supplied originals and resolving every applicable constraint, correction, referent and referenced pending intent. Read needed deferred originals through contextRequests before deciding; never certify unseen content.") +
              " This certifies source selection, not completion of future tool work.",
          },
        },
      },
    },
  };
}

export const HISTORY_REFERENCE_PREFIX = "history:";
export const ALL_HISTORY_REFERENCE = "history:all";
const HISTORY_SEARCH_PREFIX = "history:search:";
const HISTORY_USER_SEARCH_PREFIX = "history:search-user:";
const HISTORY_ASSISTANT_SEARCH_PREFIX = "history:search-assistant:";
type HistorySearchSpeaker = "user" | "assistant";

/** Speaker scope filters search candidates, never retained constraints or authority. */
function historySearchRequest(
  name: string,
): { query: string; speaker?: HistorySearchSpeaker } | undefined {
  for (const [prefix, speaker] of [
    [HISTORY_SEARCH_PREFIX, undefined],
    [HISTORY_USER_SEARCH_PREFIX, "user"],
    [HISTORY_ASSISTANT_SEARCH_PREFIX, "assistant"],
  ] as const) {
    if (name.startsWith(prefix)) {
      const query = name.slice(prefix.length);
      return query.trim()
        ? { query, ...(speaker ? { speaker } : {}) }
        : undefined;
    }
  }
  return undefined;
}
const QUOTATION_ENDS = new Map([
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
  ["`", "`"],
  ["«", "»"],
  ["「", "」"],
]);

export interface HistoryDiscovery {
  /** Complete background review; distinct from current-request relevance. */
  checkpoint?: HistoryRetentionCheckpoint;
  /** The boundary was set by position on a host without a reviewer; nothing
   * before it was classified. */
  windowed?: boolean;
  sourceSetId: string;
  scope: HistoryRetentionScope;
  visibleEventIds: ReadonlySet<string>;
  loadedSourceIds: ReadonlySet<string>;
  /** Loaded originals the host recalled for this request, which the model has
   * not read itself: its first read of one is not a repeat. */
  recalledSourceIds?: ReadonlySet<string>;
  /** Validated original-source relationships from the same reviewed prefix. */
  dependencySourceGroups?: readonly string[][];
  /** Exact literal misses over this bound source set, never semantic absence. */
  emptySearchResults?: readonly {
    query: string;
    scannedSources: number;
    speaker?: HistorySearchSpeaker;
  }[];
  /** Complete literal hits, bound to the same originals as the loaded bodies.
   * `match: "words"` marks a query with no literal hit whose ids are the
   * originals sharing most of its words. */
  searchResults?: readonly {
    query: string;
    scannedSources: number;
    speaker?: HistorySearchSpeaker;
    matchedSourceIds: string[];
    match?: "words";
  }[];
}

export function projectReviewedHistory(
  context: ContextObject,
  scope: HistoryRetentionScope,
  checkpoint: unknown,
): HistoryDiscovery | undefined {
  const visible = visibleHistoryEventIds(context, scope, checkpoint);
  const bound = completionContextSources(context);
  if (
    !visible ||
    !bound.sources.some((source) => !visible.has(source.event.id))
  )
    return undefined;
  const sourceIdByEvent = new Map(
    bound.sources.map((source) => [source.event.id, source.id]),
  );
  const projection = {
    sourceSetId: bound.sourceSetId,
    checkpoint:
      validateHistoryRetention(context, scope, checkpoint) ?? undefined,
    scope,
    visibleEventIds: visible,
    loadedSourceIds: new Set<string>(),
    dependencySourceGroups: (
      checkpoint as HistoryRetentionCheckpoint
    ).dependencyEventGroups?.map((group) =>
      group.map((eventId) => {
        // visibleHistoryEventIds already validated every member against this prefix.
        const sourceId = sourceIdByEvent.get(eventId);
        if (!sourceId)
          throw new ElizaError(
            "Validated history dependency lost its original",
            { code: "HISTORY_RETENTION_INVALID_DEPENDENCY" },
          );
        return sourceId;
      }),
    ),
  };
  const visibleSources = new Set(
    bound.sources
      .filter((source) => visible.has(source.event.id))
      .map((source) => source.id),
  );
  for (const source of referencedHistorySources(
    bound,
    projection,
    visibleSources,
  ))
    projection.loadedSourceIds.add(source.id);
  return projection;
}

/** Keep canonical events intact; metadata carries only a validated rendering view. */
export function withBackgroundHistory(
  context: ContextObject,
  history?: HistoryDiscovery,
): ContextObject {
  if (
    !history?.checkpoint ||
    history.sourceSetId !== completionContextSources(context).sourceSetId
  )
    return context;
  return {
    ...context,
    metadata: {
      ...context.metadata,
      backgroundHistory: {
        sourceSetId: history.sourceSetId,
        scope: history.scope,
        checkpoint: history.checkpoint,
        loadedSourceIds: [...history.loadedSourceIds],
        ...(history.windowed ? { windowed: true } : {}),
      } as unknown as JsonValue,
    },
  };
}

/** Revalidate the complete review and exact current-turn originals on every view. */
export function projectBackgroundHistory(context: ContextObject) {
  const full = {
    context,
    applied: false,
    omittedSourceCount: 0,
    windowed: false,
  };
  // Any explicit foreground review owns its fallback semantics, including full.
  if (context.metadata?.completionContext !== undefined) return full;
  const raw = context.metadata?.backgroundHistory;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return full;
  const view = raw as unknown as {
    sourceSetId: string;
    scope: HistoryRetentionScope;
    checkpoint: HistoryRetentionCheckpoint;
    loadedSourceIds: string[];
    windowed?: boolean;
  };
  if (
    !view.scope ||
    !Array.isArray(view.scope.roles) ||
    !Array.isArray(view.loadedSourceIds)
  )
    return full;
  const bound = completionContextSources(context);
  if (view.sourceSetId !== bound.sourceSetId) return full;
  let history: HistoryDiscovery | undefined;
  try {
    history = projectReviewedHistory(context, view.scope, view.checkpoint);
  } catch {
    // error-policy:J3 Invalid optional projection metadata retains full originals.
    return full;
  }
  if (
    !history ||
    view.loadedSourceIds.some(
      (id) => !bound.sources.some((source) => source.id === id),
    )
  )
    return full;
  const included = new Set(history.visibleEventIds);
  for (const source of bound.sources)
    if (view.loadedSourceIds.includes(source.id)) included.add(source.event.id);
  const omitted = new Set<ContextEvent>(
    bound.sources
      .filter((source) => !included.has(source.event.id))
      .map((source) => source.event),
  );
  if (!omitted.size) return full;
  const events = selectHistoricalNavigation(context, included, {
    historicalEffects: "settled",
    requestNotes: true,
  }).events.filter((event) => !omitted.has(event));
  // The scope sentence introduces navigation entries; alone it describes nothing.
  const navigationShown = events.some(
    (event) =>
      event.type === "segment" &&
      "segment" in event &&
      (event.segment as { label?: string }).label ===
        "runtime:historical_navigation",
  );
  return {
    context: {
      ...context,
      events: navigationShown
        ? events
        : events.filter((event) => event.id !== "historical-navigation-scope"),
    },
    applied: true,
    omittedSourceCount: omitted.size,
    windowed: view.windowed === true,
  };
}

export function historyReferences(
  context: ContextObject,
  projection?: HistoryDiscovery,
): Set<string> {
  if (!projection) return new Set();
  const bound = completionContextSources(context);
  if (projection.sourceSetId !== bound.sourceSetId) return new Set();
  return new Set([
    ALL_HISTORY_REFERENCE,
    // A model may explicitly reread a retained original already inline.
    // Resolve it through the same fresh authorization/source checks once;
    // a repeated explicit read restores full history instead of failing
    // as an unknown provider or entering an unbounded read loop.
    ...bound.sources.map((source) => `${HISTORY_REFERENCE_PREFIX}${source.id}`),
  ]);
}

/** Snapshot only the already offered canonical reads. No numeric string alias is added. */
export function nativeHistoryReadBinding(
  context: ContextObject,
  projection: HistoryDiscovery | undefined,
  available: ReadonlySet<string>,
  scope: HistoryRetentionScope,
): NativeHistoryReadBinding | undefined {
  if (!projection) return undefined;
  const bound = completionContextSources(context);
  const sameScope = () =>
    projection.scope.agentId === scope.agentId &&
    projection.scope.roomId === scope.roomId &&
    projection.scope.entityId === scope.entityId &&
    projection.scope.roles.length === scope.roles.length &&
    projection.scope.roles.every((role, index) => role === scope.roles[index]);
  if (projection.sourceSetId !== bound.sourceSetId || !sameScope())
    return undefined;
  const sources = new Map<number, string>();
  bound.sources.forEach(({ id }, index) => {
    const canonical = `${HISTORY_REFERENCE_PREFIX}${id}`;
    if (id === `h${index + 1}` && available.has(canonical))
      sources.set(index + 1, canonical);
  });
  return {
    sourceSetId: bound.sourceSetId,
    sources,
    ...(available.has(ALL_HISTORY_REFERENCE)
      ? { all: ALL_HISTORY_REFERENCE }
      : {}),
    assertCurrent() {
      if (
        !sameScope() ||
        projection.sourceSetId !== completionContextSources(context).sourceSetId
      ) {
        throw new ElizaError("The history read source identity changed.", {
          code: "CONTEXT_DISCOVERY_INVALID_READ",
        });
      }
    },
    search(speaker, query) {
      const prefix =
        speaker === "user"
          ? HISTORY_USER_SEARCH_PREFIX
          : speaker === "assistant"
            ? HISTORY_ASSISTANT_SEARCH_PREFIX
            : HISTORY_SEARCH_PREFIX;
      const reference = prefix + query;
      if (!historySearchRequest(reference)) {
        throw new ElizaError(
          "A history search needs a nonblank literal query.",
          { code: "CONTEXT_DISCOVERY_INVALID_READ" },
        );
      }
      return reference;
    },
  };
}

/** Admit literal queries, bare bound source IDs (hN, the form history labels
 * print) and exact bound source event IDs (history:<message id>, the
 * requestSourceEventId historical receipts print) only while the optional
 * source-bound history index is active. Each alias resolves to its canonical
 * history:hN read, and only when that read is offered; an advertised provider
 * of the same name keeps its own reference. Execution still follows fresh
 * authorization and source checks. */
export function readHistoryContextRequests(
  context: ContextObject,
  projection: HistoryDiscovery | undefined,
  raw: Record<string, unknown> | null,
  available: ReadonlySet<string>,
): string[] {
  const references = new Set(available);
  const aliases = new Map<string, string>();
  if (projection && Array.isArray(raw?.contextRequests)) {
    const bound = completionContextSources(context);
    if (projection.sourceSetId === bound.sourceSetId) {
      for (const { id, event } of bound.sources) {
        const canonical = `${HISTORY_REFERENCE_PREFIX}${id}`;
        if (!available.has(id) && available.has(canonical))
          aliases.set(id, canonical);
        if (!available.has(event.id) && available.has(canonical))
          aliases.set(event.id, canonical);
      }
      for (const name of raw.contextRequests) {
        if (
          typeof name === "string" &&
          (aliases.has(name) || historySearchRequest(name))
        )
          references.add(name);
      }
    }
  }
  return [
    ...new Set(
      readContextRequests(raw, references).map(
        (name) => aliases.get(name) ?? name,
      ),
    ),
  ];
}

/** An explicit provider request is handled first. Otherwise an incomplete
 * decision restores originals, and any selected-but-unseen source is read before
 * processing even if the model forgot the explicit contextRequests entry. */
export function requestedHistory(
  context: ContextObject,
  projection: HistoryDiscovery | undefined,
  raw: Record<string, unknown> | null,
  explicit: readonly string[],
  explicitRead = false,
): string[] {
  if (!projection) return [];
  const bound = completionContextSources(context);
  const selection = parseCompletionContextSelection(raw?.completionContext);
  if (bound.sourceSetId !== projection.sourceSetId)
    return [ALL_HISTORY_REFERENCE];
  const requested = explicit.filter((name) =>
    name.startsWith(HISTORY_REFERENCE_PREFIX),
  );
  if (
    requested.includes(ALL_HISTORY_REFERENCE) ||
    requested.some((name) => {
      const id = name.slice(HISTORY_REFERENCE_PREFIX.length);
      return (
        projection.loadedSourceIds.has(id) &&
        !projection.recalledSourceIds?.has(id)
      );
    })
  )
    return [...new Set([...requested, ALL_HISTORY_REFERENCE])];
  // Native read decisions select references, not completion sources. Their
  // names were authorized above; the ordinary fresh read barrier still runs.
  if (explicitRead) return requested;
  // A complete background review permits its advertised view without assigning
  // foreground relevance. Explicit malformed/incomplete selections still restore.
  // A reply with no decision at all selected nothing either: it takes the
  // ordinary Stage-1 retry instead of restoring the whole room.
  if (
    !(raw && "completionContext" in raw) &&
    projection.checkpoint &&
    validateHistoryRetention(context, projection.scope, projection.checkpoint)
  )
    return requested;
  if (explicit.length > 0 && requested.length === 0) return [];
  if (
    !selection ||
    selection.sourceSetId !== bound.sourceSetId ||
    (!explicit.length && (!selection.complete || selection.mode !== "selected"))
  )
    return [ALL_HISTORY_REFERENCE];
  const selected = [
    ...selection.relevantSourceIds,
    ...selection.constraintSourceIds,
    ...selection.referentSourceIds,
    ...selection.pendingIntentSourceIds,
  ];
  if (selected.some((id) => !bound.sources.some((source) => source.id === id)))
    return [ALL_HISTORY_REFERENCE];
  const reply = raw?.replyText;
  // A selected assistant recap can quote the original evidence even when the
  // new draft paraphrases it. Resolve those exact source dependencies through
  // the same authorized read barrier instead of treating the recap as proof.
  const quotationTexts = [
    ...(typeof reply === "string"
      ? [{ text: reply, beforeSourceIndex: bound.sources.length }]
      : []),
    ...bound.sources.flatMap((source, index) =>
      selected.includes(source.id) &&
      source.event.segment.label === "prior_message:agent"
        ? [{ text: source.event.segment.content, beforeSourceIndex: index }]
        : [],
    ),
  ].filter(({ text }) => /["'“‘`«「]/.test(text));
  const quoted =
    quotationTexts.length > 0
      ? bound.sources.filter(({ id, event }, index) => {
          if (
            projection.visibleEventIds.has(event.id) ||
            projection.loadedSourceIds.has(id)
          )
            return false;
          // A displayed speaker prefix or attachment summary need not be
          // quoted. This only finds a read candidate; load the complete
          // original with its identity.
          return quotationTexts.some(
            ({ text, beforeSourceIndex }) =>
              index < beforeSourceIndex &&
              (quotesCompleteSource(text, event.segment.content) ||
                quotesCompleteSource(text, priorMessageBody(event.segment))),
          );
        })
      : [];
  const linked = referencedHistorySources(bound, projection, new Set(selected));
  return [
    ...new Set([
      ...requested,
      ...selected
        .filter((id) => {
          const source = bound.sources.find((row) => row.id === id);
          return (
            source &&
            !projection.visibleEventIds.has(source.event.id) &&
            !projection.loadedSourceIds.has(id)
          );
        })
        .map((id) => `${HISTORY_REFERENCE_PREFIX}${id}`),
      ...quoted.map(({ id }) => `${HISTORY_REFERENCE_PREFIX}${id}`),
      ...linked.map(({ id }) => `${HISTORY_REFERENCE_PREFIX}${id}`),
    ]),
  ];
}

/** A prior message's quotable text: its segment without the speaker prefix and
 * without the attachment summary that dialogue context appends after it. */
function priorMessageBody(segment: ContextObjectPromptSegment): string {
  const speaker = segment.metadata?.speakerName;
  const prefix = typeof speaker === "string" ? `${speaker}: ` : "";
  const content =
    prefix && segment.content.startsWith(prefix)
      ? segment.content.slice(prefix.length)
      : segment.content;
  const summary = segment.metadata?.attachmentSummary;
  if (typeof summary !== "string") return content;
  if (content === summary) return "";
  return content.endsWith(` ${summary}`)
    ? content.slice(0, -summary.length - 1)
    : content;
}

/** Stored quote links request only unchanged, earlier originals already in this
 * authorized room. The existing dependency closure preserves linked corrections. */
function referencedHistorySources(
  bound: ReturnType<typeof completionContextSources>,
  projection: HistoryDiscovery,
  sourceIds: ReadonlySet<string>,
) {
  const byId = new Map(
    bound.sources.map((source, index) => [source.id, { source, index }]),
  );
  const byEvent = new Map(
    bound.sources.map((source, index) => [source.event.id, { source, index }]),
  );
  const duplicateEvents = new Set<string>();
  const seenEvents = new Set<string>();
  for (const { event } of bound.sources) {
    if (seenEvents.has(event.id)) duplicateEvents.add(event.id);
    seenEvents.add(event.id);
  }
  const pending = new Set(sourceIds);
  includeLinkedSources(pending, projection.dependencySourceGroups ?? []);
  // Set iteration also visits newly added dependencies, once each.
  for (const id of pending) {
    const entry = byId.get(id);
    if (entry?.source.event.segment.label !== "prior_message:agent") continue;
    const { source: reply, index } = entry;
    if (reply.event.segment.metadata?.roomId !== projection.scope.roomId)
      continue;
    const text = priorMessageBody(reply.event.segment);
    const stored = reply.event.segment.metadata?.sourceReplyReferences;
    const references =
      readSourceReplyReferences(stored, text) ??
      readSourceReplyReferences(stored, reply.event.segment.content);
    for (const reference of references?.sources ?? []) {
      const target = byEvent.get(reference.eventId);
      if (
        !target ||
        duplicateEvents.has(reference.eventId) ||
        target.index >= index
      )
        continue;
      const { source } = target;
      if (
        source.event.segment.metadata?.roomId !== projection.scope.roomId ||
        sourceReplyEventHash(source.event) !== reference.sourceSha256 ||
        !priorMessageBody(source.event.segment) ||
        !text.includes(priorMessageBody(source.event.segment))
      )
        continue;
      if (!pending.has(source.id)) {
        pending.add(source.id);
        includeLinkedSources(pending, projection.dependencySourceGroups ?? []);
      }
    }
  }
  return bound.sources.filter(
    (source) =>
      pending.has(source.id) &&
      !projection.visibleEventIds.has(source.event.id) &&
      !projection.loadedSourceIds.has(source.id),
  );
}

/** Complete earlier sources behind assistant quotations; these are read
 * candidates, never proof of speaker attribution or authority. */
function quotedHistorySources(
  bound: ReturnType<typeof completionContextSources>,
  projection: HistoryDiscovery,
  quotationTexts: readonly { text: string; beforeSourceIndex: number }[],
) {
  return quotationTexts.length > 0
    ? bound.sources.filter(({ id, event }, index) => {
        if (
          projection.visibleEventIds.has(event.id) ||
          projection.loadedSourceIds.has(id)
        )
          return false;
        // Sources are in the same chronological order as their hN labels.
        // A later echo cannot be the original behind an earlier recap.
        // Current-draft quotes may still refer to any prior source.
        const earlierQuotes = quotationTexts.filter(
          ({ beforeSourceIndex }) => index < beforeSourceIndex,
        );
        // A displayed speaker prefix or attachment summary need not be quoted.
        // This only finds a read candidate; load the complete original with
        // its identity.
        return earlierQuotes.some(
          ({ text }) =>
            quotesCompleteSource(text, event.segment.content) ||
            quotesCompleteSource(text, priorMessageBody(event.segment)),
        );
      })
    : [];
}

/** A draft can copy an entire original from a visible assistant recap while
 * selecting only that recap. Materialize matching deferred originals through
 * the normal read barrier before dispatch. A literal match is a read candidate,
 * not a certificate of authorship, authority or semantic answer correctness.
 * No partial/fuzzy match, source rewrite or interpretation of the user's intent
 * is involved. Duplicate original occurrences remain separate read candidates. */
function quotesCompleteSource(reply: string, content: string): boolean {
  if (!content || content.length + 2 > reply.length) return false;
  for (
    let at = reply.indexOf(content);
    at >= 0;
    at = reply.indexOf(content, at + 1)
  ) {
    let before = at - 1;
    let after = at + content.length;
    // Quotation layout may put a newline outside the source text. These
    // cursors inspect only the draft framing; source bytes stay untouched.
    while (before >= 0 && /\s/u.test(reply[before])) before--;
    while (after < reply.length && /\s/u.test(reply[after])) after++;
    if (
      before >= 0 &&
      after < reply.length &&
      QUOTATION_ENDS.get(reply[before]) === reply[after]
    )
      return true;
  }
  return false;
}

/** An incomplete selection may accompany contradictory routing rather than a
 * missing original. Allow one response-contract repair only when every selected
 * source is already supplied and the selection still matches this projection.
 * This does not certify completion; an unresolved retry still restores history. */
export function canRepairIncompleteHistorySelection(
  context: ContextObject,
  projection: HistoryDiscovery | undefined,
  raw: Record<string, unknown> | null,
): boolean {
  if (!projection) return false;
  const selection = parseCompletionContextSelection(raw?.completionContext);
  if (!selection || selection.complete || selection.mode !== "selected")
    return false;
  const bound = completionContextSources(context);
  if (
    bound.sourceSetId !== projection.sourceSetId ||
    selection.sourceSetId !== bound.sourceSetId
  )
    return false;
  return [
    ...selection.relevantSourceIds,
    ...selection.constraintSourceIds,
    ...selection.referentSourceIds,
    ...selection.pendingIntentSourceIds,
  ].every((id) => {
    const source = bound.sources.find((row) => row.id === id);
    return (
      !!source &&
      (projection.visibleEventIds.has(source.event.id) ||
        projection.loadedSourceIds.has(id))
    );
  });
}

/** A malformed binding is never accepted. An otherwise complete selection of
 * supplied originals may be regenerated once before restoring all history. */
export function canRepairHistoryIdentity(
  context: ContextObject,
  projection: HistoryDiscovery | undefined,
  raw: Record<string, unknown> | null,
): boolean {
  if (!projection) return false;
  const selection = parseCompletionContextSelection(raw?.completionContext);
  if (
    !selection?.complete ||
    selection.mode !== "selected" ||
    // A truncated hex copy is also a binding error, not missing evidence.
    !/^[0-9a-f]+$/.test(selection.sourceSetId)
  )
    return false;
  const bound = completionContextSources(context);
  if (
    bound.sourceSetId !== projection.sourceSetId ||
    selection.sourceSetId === bound.sourceSetId
  )
    return false;
  return [
    ...selection.relevantSourceIds,
    ...selection.constraintSourceIds,
    ...selection.referentSourceIds,
    ...selection.pendingIntentSourceIds,
  ].every((id) => {
    const source = bound.sources.find((row) => row.id === id);
    return (
      !!source &&
      (projection.visibleEventIds.has(source.event.id) ||
        projection.loadedSourceIds.has(id))
    );
  });
}

/** A wrong identifier domain is a malformed output, not evidence that more
 * history is needed. Offer one fresh model decision over the SAME originals.
 * The sanitized copy below is used ONLY to classify the error; it is never
 * dispatched, persisted or accepted as the model's selection. */
export function repairableHistorySourceIds(
  context: ContextObject,
  projection: HistoryDiscovery | undefined,
  raw: Record<string, unknown> | null,
): string[] | undefined {
  if (!projection) return undefined;
  const value = raw?.completionContext;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const candidate = { ...(value as Record<string, unknown>) };
  let malformed = false;
  for (const key of [
    "relevantSourceIds",
    "constraintSourceIds",
    "referentSourceIds",
    "pendingIntentSourceIds",
  ]) {
    const ids = candidate[key];
    if (
      !Array.isArray(ids) ||
      ids.some((id) => typeof id !== "string") ||
      new Set(ids).size !== ids.length
    )
      return undefined;
    candidate[key] = ids.filter((id) => {
      if (/^h[1-9]\d*$/.test(id)) return true;
      malformed = true;
      return false;
    });
  }
  const selection = parseCompletionContextSelection(candidate);
  if (!malformed || !selection?.complete || selection.mode !== "selected")
    return undefined;
  const bound = completionContextSources(context);
  if (
    bound.sourceSetId !== projection.sourceSetId ||
    selection.sourceSetId !== bound.sourceSetId
  )
    return undefined;
  const supplied = bound.sources
    .filter(
      ({ id, event }) =>
        projection.visibleEventIds.has(event.id) ||
        projection.loadedSourceIds.has(id),
    )
    .map(({ id }) => id);
  const selected = [
    ...selection.relevantSourceIds,
    ...selection.constraintSourceIds,
    ...selection.referentSourceIds,
    ...selection.pendingIntentSourceIds,
  ];
  return selected.every((id) => supplied.includes(id)) ? supplied : undefined;
}

// Marks stay with their letters: without them a word in a script that writes
// vowels as marks falls apart into fragments.
const wordsOf = (text: string): string[] =>
  text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
/** A message has a query word when it has that word, or one of four letters
 * or more that differs from it by an ending of up to three: "book" and
 * "booked" find each other; "table" does not find "vegetables", "car" does
 * not find "card", "pass" does not find "passport". */
const hasWord = (message: readonly string[], word: string): boolean =>
  message.some((own) => {
    if (own === word) return true;
    const [short, long] = own.length < word.length ? [own, word] : [word, own];
    return (
      short.length >= 4 &&
      long.length - short.length <= 3 &&
      long.startsWith(short)
    );
  });
const queryWords = (text: string): string[] => [
  ...new Set(wordsOf(text).filter((word) => word.length >= 3)),
];

const HISTORY_RECALL_SOURCES = 3;
/** Looser, a real 283-message conversation recalled something on one turn in
 * five and re-sent its transcript each time; at two, on one turn in 25. */
const HISTORY_RECALL_HOLDERS = 2;
const HISTORY_RECALL_REQUEST_WORDS = 40;

/**
 * Deferred originals that share at least two distinctive words with the
 * current request, each with the other half of its exchange, added to what the
 * turn is shown. A positional window hides "my gate code is 4471" from "what's
 * my gate code again?"; a model then has to notice the gap and read, and on a
 * live model it denied having the fact in about one request in eight instead.
 * A word is distinctive when at most two of the conversation's messages
 * contain it.
 */
export function recallDeferredHistory(
  context: ContextObject,
  projection: HistoryDiscovery,
  request: string,
): HistoryDiscovery {
  const bound = completionContextSources(context);
  if (bound.sourceSetId !== projection.sourceSetId) return projection;
  const texts = bound.sources.map((source) =>
    wordsOf(source.event.segment.content),
  );
  const words = queryWords(request);
  // A pasted document is not a reference to something said earlier, and
  // matching its every word against every message is the costly case.
  if (words.length > HISTORY_RECALL_REQUEST_WORDS) return projection;
  const distinctive = words.filter((word) => {
    let holders = 0;
    for (const text of texts)
      if (hasWord(text, word) && ++holders > HISTORY_RECALL_HOLDERS)
        return false;
    return holders > 0;
  });
  if (distinctive.length < 2) return projection;
  const shown = (index: number) =>
    projection.visibleEventIds.has(bound.sources[index].event.id) ||
    projection.loadedSourceIds.has(bound.sources[index].id);
  const recalled = texts
    .map((text, index) => ({
      index,
      shared: shown(index)
        ? 0
        : distinctive.filter((word) => hasWord(text, word)).length,
    }))
    .filter(({ shared }) => shared >= 2)
    .sort(
      (left, right) => right.shared - left.shared || right.index - left.index,
    )
    .slice(0, HISTORY_RECALL_SOURCES);
  if (!recalled.length) return projection;
  const loadedSourceIds = new Set(projection.loadedSourceIds);
  const recalledSourceIds = new Set(projection.recalledSourceIds);
  const fromUser = (index: number) =>
    bound.sources[index]?.event.segment.label === "prior_message:user";
  const recall = (index: number) => {
    loadedSourceIds.add(bound.sources[index].id);
    recalledSourceIds.add(bound.sources[index].id);
  };
  for (const { index } of recalled) {
    recall(index);
    // A question without its answer, or an answer without its question, is
    // half of what was said.
    const partner = fromUser(index) ? index + 1 : index - 1;
    if (
      bound.sources[partner] &&
      fromUser(partner) !== fromUser(index) &&
      !shown(partner)
    )
      recall(partner);
  }
  return { ...projection, loadedSourceIds, recalledSourceIds };
}

const HISTORY_WORD_MATCHES = 5;

/**
 * Originals that best share the words of a query that matched nothing
 * literally. A model searches for a subject ("cabin wifi password") more often
 * than for a phrase the conversation contains ("the wifi password at the
 * cabin"); a bare literal miss then reads as "never said". A word counts for
 * less the more messages contain it, so "what did you say about the gate
 * code" is decided by "gate" and "code". A match shares two words and half
 * the weight of the query's words the conversation contains. Of the best,
 * the newest few not already in view come first.
 */
function historyWordMatches<
  T extends { event: { segment: { content: string } } },
>(
  candidates: readonly T[],
  query: string,
  inView: (source: T) => boolean,
): T[] {
  const words = queryWords(query);
  if (words.length < 2) return [];
  const texts = candidates.map((source) =>
    wordsOf(source.event.segment.content),
  );
  const weight = new Map(
    words.map((word) => {
      const holders = texts.filter((text) => hasWord(text, word)).length;
      return [word, holders ? Math.log(1 + texts.length / holders) : 0];
    }),
  );
  let total = 0;
  for (const value of weight.values()) total += value;
  let best = 0;
  const scored = candidates.flatMap((source, index) => {
    const shared = words.filter((word) => hasWord(texts[index], word));
    let score = 0;
    for (const word of shared) score += weight.get(word) ?? 0;
    if (shared.length < 2 || score < total / 2) return [];
    best = Math.max(best, score);
    return [{ source, index, score }];
  });
  return scored
    .filter(({ score }) => score >= best - 1e-9)
    .sort(
      (left, right) =>
        Number(inView(left.source)) - Number(inView(right.source)) ||
        right.index - left.index,
    )
    .slice(0, HISTORY_WORD_MATCHES)
    .sort((left, right) => left.index - right.index)
    .map(({ source }) => source);
}

/** Called only after ordinary context-request validation and fresh source/role
 * checks. An absent projection renders every current authorized original;
 * completed read evidence survives that restoration independently. */
export function loadHistoryReferences(
  context: ContextObject,
  projection: HistoryDiscovery | undefined,
  requested: readonly string[],
): { projection?: HistoryDiscovery; evidence?: HistoryDiscovery } {
  if (!projection) return {};
  const bound = completionContextSources(context);
  if (bound.sourceSetId !== projection.sourceSetId) return {};
  const loadedSourceIds = new Set(projection.loadedSourceIds);
  // What the model reads here it has now read itself.
  const recalledSourceIds = new Set(projection.recalledSourceIds);
  const unread = (id: string) =>
    !projection.loadedSourceIds.has(id) || recalledSourceIds.delete(id);
  let searched = false;
  let searchAddedSource = false;
  const emptySearchResults = [...(projection.emptySearchResults ?? [])];
  const searchResults = [...(projection.searchResults ?? [])];
  for (const name of requested) {
    if (name === ALL_HISTORY_REFERENCE) continue;
    const search = historySearchRequest(name);
    if (search) {
      searched = true;
      const query = search.query.toLowerCase();
      const candidates = search.speaker
        ? bound.sources.filter(
            (source) =>
              source.event.segment.label ===
              (search.speaker === "user"
                ? "prior_message:user"
                : "prior_message:agent"),
          )
        : bound.sources;
      const literal = candidates.filter((source) =>
        source.event.segment.content.toLowerCase().includes(query),
      );
      const matches = literal.length
        ? literal
        : historyWordMatches(
            candidates,
            query,
            (source) =>
              projection.visibleEventIds.has(source.event.id) ||
              projection.loadedSourceIds.has(source.id),
          );
      const result = { ...search, scannedSources: candidates.length };
      searchResults.push({
        ...result,
        matchedSourceIds: matches.map((source) => source.id),
        ...(matches.length && !literal.length
          ? { match: "words" as const }
          : {}),
      });
      if (matches.length === 0) emptySearchResults.push(result);
      for (const source of matches) {
        if (unread(source.id)) searchAddedSource = true;
        loadedSourceIds.add(source.id);
      }
    } else if (name.startsWith(HISTORY_REFERENCE_PREFIX)) {
      const id = name.slice(HISTORY_REFERENCE_PREFIX.length);
      recalledSourceIds.delete(id);
      loadedSourceIds.add(id);
    }
  }
  // Supply complete earlier originals alongside freshly requested assistant recaps.
  const quotationTexts = bound.sources.flatMap((source, index) =>
    loadedSourceIds.has(source.id) &&
    !projection.loadedSourceIds.has(source.id) &&
    source.event.segment.label === "prior_message:agent"
      ? [{ text: source.event.segment.content, beforeSourceIndex: index }]
      : [],
  );
  for (const source of quotedHistorySources(
    bound,
    { ...projection, loadedSourceIds },
    quotationTexts,
  ))
    loadedSourceIds.add(source.id);
  // A literal hit still reports only its actual matches. Supply the complete
  // validated correction/cancellation chain as additional original evidence.
  includeLinkedSources(
    loadedSourceIds,
    projection.dependencySourceGroups ?? [],
  );
  for (const source of referencedHistorySources(
    bound,
    projection,
    loadedSourceIds,
  ))
    loadedSourceIds.add(source.id);
  const evidence = {
    ...projection,
    loadedSourceIds,
    recalledSourceIds,
    emptySearchResults,
    searchResults,
  };
  // Restore all originals for explicit full reads or repeated no-progress
  // searches, but retain the exact completed lookup results for later stages.
  const restoreAll =
    requested.includes(ALL_HISTORY_REFERENCE) ||
    (searched &&
      !searchAddedSource &&
      (emptySearchResults.length === 0 ||
        !!projection.emptySearchResults?.length));
  return { projection: restoreAll ? undefined : evidence, evidence };
}

export const REVIEWED_HISTORY_SELECTION_INSTRUCTIONS = `History selection: use the separate source map to identify original dialogue. Select facts, applicable constraints/corrections, referents and explicitly continued unfinished work; a complete selection retains their exact union, never a summary. Prior selection can miss dependencies.
Read missing originals through READ_CONTEXT or contextRequests (empty reply/action fields): history:hN for known IDs; history:search:<literal>, history:search-user:<literal> or history:search-assistant:<literal> for case-insensitive substring search. For a specific saved-fact lookup, first read an advertised stored-memory reference, a known history ID or a literal search of the fact's subject. When only the fact's location is unknown, search its subject first. Inspect matched originals and their corrections before requesting broader history. Search subjects as well as current values to find corrections. Speaker filters mean roles, not people. Matches establish occurrences, not earliest versions; zero matches establish literal absence only. Use history:all when targeted reads leave dependencies or interpretation unresolved, for exhaustive coverage, or before claiming something was never discussed. These are conversation reads, not external app actions; do not reread supplied originals or infer omitted permission.
Once dependencies are resolved, use relevant_prior_dialogue with complete=true and the sourceSetId required by the response schema. Incomplete selection restores all originals. Original speaker attribution, current request, system/provider constraints, receipts and retention checkpoints remain intact. Navigation receipts follow their original request.`;

export function historyReferenceNotice(
  context: ContextObject,
  projection?: HistoryDiscovery,
): string {
  if (!projection) return "";
  return `\nHistory index: history:h1–history:h${collectCompletionContextSources(context).length} in chronological order. For a specific saved-fact lookup, first use an advertised stored-memory reference, a known history:hN, or history:search:<text> for the fact's subject; inspect matched originals and their corrections. Read all originals with history:all when targeted reads leave dependencies unresolved, for exhaustive coverage, or before claiming something was never discussed. Supplied/loaded originals need no reread.`;
}

/** Matches print as the history:hN reads READ_CONTEXT accepts. */
function historySearchReceipt(
  sourceSetId: string,
  results: NonNullable<HistoryDiscovery["searchResults"]>,
): string {
  return JSON.stringify({
    sourceSetId,
    matchMode: "case-insensitive literal substring",
    results: results.map((result) => ({
      ...result,
      matchedSourceIds: result.matchedSourceIds.map(
        (id) => `${HISTORY_REFERENCE_PREFIX}${id}`,
      ),
      matchedSources: result.matchedSourceIds.length,
    })),
  });
}

/** Carry completed conversation lookups into planning only while their sources remain identical. */
export function withHistoryReadEvidence(
  context: ContextObject,
  projection?: HistoryDiscovery,
): ContextObject {
  if (!projection?.searchResults?.length) return context;
  const bound = completionContextSources(context);
  if (bound.sourceSetId !== projection.sourceSetId) return context;
  return {
    ...context,
    events: [
      ...context.events,
      {
        id: "history-read-evidence",
        type: "segment",
        source: "message-service",
        segment: {
          id: "history-read-evidence",
          stable: false,
          content: `Completed current-turn conversation reads: ${historySearchReceipt(bound.sourceSetId, projection.searchResults)}\nRuntime receipts, not a generated reply or an app-record lookup. Exact matches refer to original source IDs, not inferred facts or permission. A result marked match "words" had no literal hit and lists the few originals that best share the query's words. An optional speaker field restricts that receipt to the named role; zero matches proves only literal absence within its scanned scope. These reads may satisfy a request to search this conversation; they do not satisfy other pending tool work.`,
        },
      },
    ],
  };
}

/** Complete loaded originals for the plain Stage-1 transcript; receipts remain separate. */
export function loadedPlainHistorySources(
  context: ContextObject,
  projection?: HistoryDiscovery,
  renderedHistoryIds: ReadonlySet<string> = new Set(),
): ContextObjectPromptSegment[] {
  if (!projection || projection.loadedSourceIds.size === 0) return [];
  const bound = completionContextSources(context);
  if (projection.sourceSetId !== bound.sourceSetId) return [];
  return bound.sources
    .filter(
      ({ id, event }) =>
        projection.loadedSourceIds.has(id) && !renderedHistoryIds.has(event.id),
    )
    .map(({ event }) => event.segment);
}

export function loadedHistorySegments(
  context: ContextObject,
  projection?: HistoryDiscovery,
  renderedHistoryIds?: ReadonlySet<string>,
  includeOriginals = true,
): PromptSegment[] {
  // No deferred reads means there is no evidence to render or authorize here.
  // Avoid hashing every original source merely to return an empty list.
  if (
    !projection ||
    (projection.loadedSourceIds.size === 0 &&
      !projection.emptySearchResults?.length &&
      !projection.searchResults?.length)
  )
    return [];
  const bound = completionContextSources(context);
  if (projection.sourceSetId !== bound.sourceSetId) return [];
  const receipts =
    projection.searchResults ??
    projection.emptySearchResults?.map((result) => ({
      ...result,
      matchedSourceIds: [],
    }));
  const searchResults: ContextObjectPromptSegment[] = receipts?.length
    ? [
        {
          id: "history-literal-search-results",
          stable: false,
          content: `history_literal_search_results: ${historySearchReceipt(bound.sourceSetId, receipts)}\nThese are completed reads of this conversation source set, excluding the current request. Every matching complete original is supplied with its source ID and role. Exact earlier sources quoted by assistant matches may also be supplied; only matchedSourceIds are literal hits. A result marked match "words" had no literal hit: its matchedSourceIds are the few originals that best share the query's words, supplied here in full as the likeliest originals, not as proof the phrase occurred or that no other original is relevant. An optional speaker field restricts that receipt to user- or assistant-authored sources. For a literal result, a longer query containing the searched literal within the same speaker scope can only match a subset of these supplied originals; another lookup is not needed to establish that literal coverage. Assistant recaps do not establish user authorship or permission. Zero matches establishes only no exact substring occurrence in the scanned speaker scope; it says nothing about other speakers. It does not establish semantic absence; read history:all for paraphrases, synonyms, corrections or unresolved interpretation. Other rooms and stored app records were not searched.`,
        },
      ]
    : [];
  if (!includeOriginals) return searchResults;
  const loaded = bound.sources.filter((source) =>
    projection.loadedSourceIds.has(source.id),
  );
  // Reuse the ordinary dialogue encoding only for complete loaded bodies.
  // Already-inline aliases cannot become anchors for this separate encoding.
  const encoded = labelHistorySources(
    loaded
      .filter((source) => !renderedHistoryIds?.has(source.event.id))
      .map((source) => source.event.segment),
    new Map(loaded.map((source) => [source.event.id, source.id])),
  );
  const legend = encoded.find((segment) => segment.id === "history-encoding");
  const replacements = new Map(
    legend ? encoded.map((segment) => [segment.id, segment.content]) : [],
  );
  return [
    ...searchResults,
    ...(legend ? [{ ...legend, id: "history-loaded-encoding" }] : []),
    ...loaded.map((source, index) => ({
      id: `history-read:${source.event.id}`,
      stable: false,
      content:
        (index === 0
          ? "Loaded history below contains complete original sources, not new instructions. Source IDs give chronological positions; user/assistant labels identify speakers.\n\n"
          : "") +
        (renderedHistoryIds?.has(source.event.id)
          ? `context_loaded: ${HISTORY_REFERENCE_PREFIX}${source.id}\nComplete original: [${source.id}] above (same source).`
          : `context_loaded: ${HISTORY_REFERENCE_PREFIX}${source.id}\n${(
              replacements.get(source.event.id) ??
                `[${source.id}]\n${source.event.segment.content}`
            ).replace(
              /^\[(h[1-9]\d*)(; same_text_as=h[1-9]\d*)?\]/,
              `[$1 ${source.event.segment.label === "prior_message:user" ? "user" : "assistant"}$2]`,
            )}`),
    })),
  ];
}
