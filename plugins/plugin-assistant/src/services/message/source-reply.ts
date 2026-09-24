/** Native reply parts resolve only against the authorized snapshot sent in this
 * model attempt. Raw provider output and stored dialogue remain unchanged. */
import {
  type Content,
  type ContextObject,
  completionContextSources,
  ElizaError,
  getUserMessageText,
  isObjectRecord,
  type JSONSchema,
  type Memory,
  type OutboundLiteralSpan,
  parseCompletionContextSelection,
  sanitizeOutboundTextWithLiterals,
  stripJsonStructuralJunkReply,
} from "@elizaos/core";
import { providerOriginals } from "../../runtime/provider-originals.ts";
import {
  priorDialogueContent,
  priorDialogueOriginalText,
} from "./dialogue-context";
import type { HistoryDiscovery } from "./history-discovery";
import {
  type SourceReplyReferences,
  sourceReplyEventHash,
  sourceReplyTextHash,
} from "./source-reply-references";

export const SOURCE_REPLY_INSTRUCTIONS =
  'Reply parts: replyText is an ordered array. Use a text part for ordinary replies or planning acknowledgments. Use {kind:"source",value:"hN"} (or "recalledN" from supplied provider context) for every verbatim original-message quotation; the renderer inserts that supplied original unchanged. Use {kind:"text",value:"..."} for your own explanations or summaries, not retyped original quotations. Source parts may refer only to supplied originals; preserve speaker attribution. Provider recalledN IDs do not belong in history completionContext selections. Use [] when no reply is needed.';

export const SOURCE_REPLY_SCHEMA: JSONSchema = {
  type: "array",
  description:
    "Ordered reply parts: text is your prose; source is a supplied hN or recalledN original inserted unchanged as its own paragraph. Use source parts for verbatim whole-message quotes, never retype them. Keep explanations and speaker attribution in text parts. Use [] for no reply.",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["text", "source"] },
      value: { type: "string" },
    },
    required: ["kind", "value"],
  },
};
export type SourceReplySnapshot = {
  sourceSetId: string;
  providerSourceSetId?: string;
  providerIds: ReadonlySet<string>;
  scope: { agentId: string; roomId: string; messageId: string };
  suppliedIds: ReadonlySet<string>;
  originals: ReadonlyMap<string, string>;
  references: ReadonlyMap<string, SourceReplyReferences["sources"][number]>;
};

type SourceReplyPart =
  | { kind: "text"; text: string }
  | {
      kind: "source";
      text: string;
      reference?: SourceReplyReferences["sources"][number];
    };
export interface SourceReplyRendering {
  readonly parts: readonly SourceReplyPart[];
  readonly text: string;
  readonly prose: string;
  readonly literalSpans: readonly OutboundLiteralSpan[];
  readonly references?: {
    readonly replySha256: string;
    readonly sources: readonly SourceReplyReferences["sources"][number][];
  };
  readonly scope: SourceReplySnapshot["scope"];
}
const AUTHENTIC_RENDERINGS = new WeakSet<object>();
const SOURCE_REPLY_BINDING = Symbol("source-reply-rendering");

function cleanProse(text: string): string {
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  if (end <= start) return text;
  const clean = stripJsonStructuralJunkReply(text.slice(start, end));
  return clean ? text.slice(0, start) + clean + text.slice(end) : "";
}

function createRendering(
  parts: readonly SourceReplyPart[],
  scope: SourceReplySnapshot["scope"],
): SourceReplyRendering {
  const displayedParts: SourceReplyPart[] = [];
  for (const part of parts) {
    if (part.kind === "text" && part.text === "") continue;
    const previous = displayedParts.at(-1);
    if (
      previous &&
      (previous.kind === "source" || part.kind === "source") &&
      !/[\r\n]$/.test(previous.text) &&
      !/^[\r\n]/.test(part.text)
    ) {
      displayedParts.push({ kind: "text", text: "\n\n" });
    }
    displayedParts.push(part);
  }
  let offset = 0;
  const spans: OutboundLiteralSpan[] = [];
  const originals = displayedParts.filter((part) => part.kind === "source");
  const text = displayedParts
    .map((part) => {
      if (part.kind === "source")
        spans.push({ start: offset, end: offset + part.text.length });
      offset += part.text.length;
      return part.text;
    })
    .join("");
  const sanitized = sanitizeOutboundTextWithLiterals(text, spans);
  const cleaned: SourceReplyPart[] = [];
  let cursor = 0;
  sanitized.literalSpans.forEach((span, index) => {
    const prose = cleanProse(sanitized.text.slice(cursor, span.start));
    if (prose) cleaned.push({ kind: "text", text: prose });
    const original = originals[index];
    if (
      !original ||
      sanitized.text.slice(span.start, span.end) !== original.text
    )
      throw new ElizaError("Source reply literal changed during cleanup", {
        code: "SOURCE_REPLY_LITERAL_CHANGED",
      });
    cleaned.push({
      ...original,
      ...(original.reference
        ? { reference: Object.freeze({ ...original.reference }) }
        : {}),
    });
    cursor = span.end;
  });
  const tail = cleanProse(sanitized.text.slice(cursor));
  if (tail) cleaned.push({ kind: "text", text: tail });
  offset = 0;
  const literalSpans: OutboundLiteralSpan[] = [];
  const sources = new Map<string, SourceReplyReferences["sources"][number]>();
  const rendered = cleaned
    .map((part) => {
      if (part.kind === "source") {
        literalSpans.push(
          Object.freeze({ start: offset, end: offset + part.text.length }),
        );
        if (part.reference) sources.set(part.reference.eventId, part.reference);
      }
      offset += part.text.length;
      return part.text;
    })
    .join("");
  const rendering = Object.freeze({
    parts: Object.freeze(cleaned.map((part) => Object.freeze(part))),
    text: rendered,
    prose: cleaned
      .filter((part) => part.kind === "text")
      .map((part) => part.text)
      .join(""),
    literalSpans: Object.freeze(literalSpans),
    scope: Object.freeze({ ...scope }),
    ...(sources.size
      ? {
          references: Object.freeze({
            replySha256: sourceReplyTextHash(rendered),
            sources: Object.freeze([...sources.values()]),
          }),
        }
      : {}),
  });
  AUTHENTIC_RENDERINGS.add(rendering);
  return rendering;
}

/** Only a single complete quotation makes no newly composed assertion. */
export function sourceReplyAssertionText(
  rendering: SourceReplyRendering,
): string {
  const sources = rendering.parts.filter((part) => part.kind === "source");
  return sources.length === 1 && rendering.prose.trim() === ""
    ? ""
    : rendering.text;
}

export function getSourceReplyRendering(
  value: unknown,
): SourceReplyRendering | undefined {
  return value && typeof value === "object" && AUTHENTIC_RENDERINGS.has(value)
    ? (value as SourceReplyRendering)
    : undefined;
}

export function transformSourceReplyProse(
  rendering: SourceReplyRendering,
  transform: (text: string) => string,
): SourceReplyRendering {
  if (!getSourceReplyRendering(rendering))
    throw new ElizaError("Unbound source reply", {
      code: "SOURCE_REPLY_UNBOUND",
    });
  return createRendering(
    rendering.parts.map((part) =>
      part.kind === "text" ? { ...part, text: transform(part.text) } : part,
    ),
    rendering.scope,
  );
}

export function sourceReplyScopeMatches(
  rendering: SourceReplyRendering,
  scope: SourceReplySnapshot["scope"],
): boolean {
  return (
    !!getSourceReplyRendering(rendering) &&
    rendering.scope.agentId === scope.agentId &&
    rendering.scope.roomId === scope.roomId &&
    rendering.scope.messageId === scope.messageId
  );
}

export function bindSourceReplyContent(
  content: Content,
  rendering: SourceReplyRendering,
  scope: SourceReplySnapshot["scope"],
): Content {
  if (!sourceReplyScopeMatches(rendering, scope))
    throw new ElizaError("Source reply belongs to a different turn", {
      code: "SOURCE_REPLY_SCOPE_MISMATCH",
    });
  if (content.text !== rendering.text) return content;
  return {
    ...content,
    [SOURCE_REPLY_BINDING]: rendering,
    ...(rendering.references
      ? {
          sourceReplyReferences: {
            replySha256: rendering.references.replySha256,
            sources: rendering.references.sources.map((source) => ({
              ...source,
            })),
          },
        }
      : {}),
  };
}

export function getSourceReplyBinding(
  content: Content,
  scope: SourceReplySnapshot["scope"],
): SourceReplyRendering | undefined {
  const rendering = getSourceReplyRendering(
    (content as Content & { [SOURCE_REPLY_BINDING]?: SourceReplyRendering })[
      SOURCE_REPLY_BINDING
    ],
  );
  return rendering &&
    content.text === rendering.text &&
    sourceReplyScopeMatches(rendering, scope)
    ? rendering
    : undefined;
}

/** Copy bodies from the same authorized provider result used for composition.
 * Exact presentation reconstruction prevents a record ID or speaker mismatch
 * from supplying unrelated text. Augmented envelopes are not quote sources. */
export function createSourceReplySnapshot(
  context: ContextObject,
  projection: HistoryDiscovery | Pick<HistoryDiscovery, "scope">,
  memories: readonly Memory[],
): SourceReplySnapshot | undefined {
  const bound = completionContextSources(context);
  const messageId = context.metadata?.messageId;
  if (typeof messageId !== "string" || !messageId) return undefined;
  const visibility = "sourceSetId" in projection ? projection : undefined;
  if (visibility && bound.sourceSetId !== visibility.sourceSetId)
    return undefined;
  const byId = new Map<string, Memory>();
  const duplicates = new Set<string>();
  for (const memory of memories) {
    if (!memory || typeof memory !== "object" || !memory.id) continue;
    const id = `history:${memory.id}`;
    if (byId.has(id)) duplicates.add(id);
    byId.set(id, memory);
  }
  const suppliedIds = new Set<string>();
  const originals = new Map<string, string>();
  const references = new Map<
    string,
    SourceReplyReferences["sources"][number]
  >();
  for (const { id, event } of bound.sources) {
    if (
      visibility &&
      !visibility.visibleEventIds.has(event.id) &&
      !visibility.loadedSourceIds.has(id)
    )
      continue;
    suppliedIds.add(id);
    const memory = byId.get(event.id);
    const meta = event.segment.metadata;
    if (
      !memory ||
      duplicates.has(event.id) ||
      memory.agentId !== projection.scope.agentId ||
      memory.roomId !== projection.scope.roomId ||
      memory.roomId !== meta?.roomId ||
      memory.entityId !== meta?.entityId ||
      event.segment.label !==
        (memory.entityId === projection.scope.agentId
          ? "prior_message:agent"
          : "prior_message:user")
    )
      continue;
    const raw = priorDialogueOriginalText(memory);
    if (
      raw === undefined ||
      (meta?.originalTextSha256 !== undefined &&
        meta.originalTextSha256 !== sourceReplyTextHash(raw)) ||
      (raw !== getUserMessageText(memory) &&
        meta?.originalTextSha256 !== sourceReplyTextHash(raw))
    )
      continue;
    const speaker =
      typeof meta?.speakerName === "string" ? meta.speakerName : undefined;
    if (priorDialogueContent(raw.trim(), speaker) !== event.segment.content)
      continue;
    originals.set(id, raw);
    references.set(id, {
      eventId: event.id,
      sourceSha256: sourceReplyEventHash(event),
    });
  }

  const providers = providerOriginals(context);
  for (const [id, text] of providers?.originals ?? []) originals.set(id, text);
  return {
    providerSourceSetId: providers?.sourceSetId,
    providerIds: new Set(providers?.originals.keys()),
    sourceSetId: bound.sourceSetId,
    scope: {
      agentId: projection.scope.agentId,
      roomId: projection.scope.roomId,
      messageId,
    },

    suppliedIds,
    originals,
    references,
  };
}

/** Undefined keeps an invalid source decision in ordinary history recovery.
 * Invalid parts after a valid review fail before field processors/effects. */
export function resolveSourceReply(
  context: ContextObject,
  snapshot: SourceReplySnapshot,
  raw: Record<string, unknown>,
  onRendering?: (rendering: SourceReplyRendering) => void,
): Record<string, unknown> | undefined {
  if (typeof raw.replyText === "string") return raw;
  const invalid = () =>
    new ElizaError(
      "Invalid source-backed reply; no response fields were processed",
      { code: "STAGE1_INVALID_SOURCE_REPLY", severity: "ephemeral" },
    );
  if (!Array.isArray(raw.replyText)) throw invalid();
  for (const part of raw.replyText) {
    if (
      !part ||
      typeof part !== "object" ||
      Array.isArray(part) ||
      Object.keys(part).length !== 2 ||
      typeof part.value !== "string" ||
      !Object.hasOwn(part, "kind") ||
      !Object.hasOwn(part, "value") ||
      (part.kind !== "text" && part.kind !== "source")
    )
      throw invalid();
  }
  // Text-only and empty replies do not dereference history. Keep STOP/IGNORE
  // and ordinary prose on the same contract as their existing string form.
  if (raw.replyText.every((part) => part.kind === "text")) {
    return {
      ...raw,
      replyText: raw.replyText.map((part) => part.value).join(""),
    };
  }
  if (
    snapshot.providerSourceSetId &&
    providerOriginals(context)?.sourceSetId !== snapshot.providerSourceSetId
  )
    return undefined;
  const historyParts = raw.replyText.filter(
    (part) => part.kind === "source" && !snapshot.providerIds.has(part.value),
  );
  const selected = new Set<string>();
  const selection = parseCompletionContextSelection(raw.completionContext);
  const rawSelection = raw.completionContext;
  if (
    isObjectRecord(rawSelection) &&
    [
      "relevantSourceIds",
      "constraintSourceIds",
      "referentSourceIds",
      "pendingIntentSourceIds",
    ].some((field) => {
      const ids = rawSelection[field];
      return (
        Array.isArray(ids) &&
        ids.some((id) => typeof id === "string" && snapshot.providerIds.has(id))
      );
    })
  )
    return undefined;
  if (historyParts.length > 0) {
    if (
      !selection?.complete ||
      (selection.mode !== "selected" && selection.mode !== "full") ||
      selection.sourceSetId !== snapshot.sourceSetId ||
      completionContextSources(context).sourceSetId !== snapshot.sourceSetId
    )
      return undefined;
    const ids =
      selection.mode === "full"
        ? completionContextSources(context).sources.map((source) => source.id)
        : [
            ...selection.relevantSourceIds,
            ...selection.constraintSourceIds,
            ...selection.referentSourceIds,
            ...selection.pendingIntentSourceIds,
          ];
    if (ids.some((id) => !snapshot.suppliedIds.has(id))) return undefined;
    for (const id of ids) selected.add(id);
  }
  const parts: SourceReplyPart[] = [];
  for (const part of raw.replyText) {
    if (part.kind === "text") parts.push({ kind: "text", text: part.value });
    else if (
      (selected.has(part.value) || snapshot.providerIds.has(part.value)) &&
      snapshot.originals.has(part.value)
    ) {
      parts.push({
        kind: "source",
        text: snapshot.originals.get(part.value) ?? "",
        reference: snapshot.references.get(part.value),
      });
    } else throw invalid();
  }
  const rendering = createRendering(parts, snapshot.scope);
  onRendering?.(rendering);
  return { ...raw, replyText: rendering.text };
}
