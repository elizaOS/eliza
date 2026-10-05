/** Lossless provider-original presentation; metadata is usable only when it
 * reconstructs the exact authorized text supplied to the model. */
import {
  type ContextObject,
  hashStableJson,
  isObjectRecord,
} from "@elizaos/core";

export interface ProviderOriginalMessages {
  header: string;
  sources: ({
    id: string;
    prefix: string;
    memoryId: string | null;
    agentId: string | null;
    roomId: string;
    entityId: string;
    createdAt: number | null;
  } & (
    | { originalText: string; text?: never }
    | { text: string; originalText?: never }
  ))[];
}

export function renderProviderOriginalMessages(
  messages: ProviderOriginalMessages,
): string {
  return [
    messages.header,
    ...messages.sources.map(
      (source) =>
        `${source.id}: ${source.prefix}${source.originalText ?? source.text}`,
    ),
  ].join("\n");
}

export function readProviderOriginalMessages(
  text: string,
  value: unknown,
): ProviderOriginalMessages | undefined {
  if (
    !isObjectRecord(value) ||
    typeof value.header !== "string" ||
    !Array.isArray(value.sources) ||
    value.sources.length === 0
  )
    return;
  const sources: ProviderOriginalMessages["sources"] = [];
  const ids = new Set<string>();
  const identities = new Set<string>();
  for (const source of value.sources) {
    if (!isObjectRecord(source)) return;
    const original = source.originalText;
    const body = original ?? source.text;
    const isOriginal = typeof original === "string";
    if (
      typeof source.id !== "string" ||
      !(isOriginal ? /^recalled[1-9]\d*$/ : /^record[1-9]\d*$/).test(
        source.id,
      ) ||
      typeof source.prefix !== "string" ||
      typeof body !== "string" ||
      (isOriginal
        ? !original || source.text !== undefined
        : original !== undefined) ||
      !(
        typeof source.memoryId === "string" ||
        (!isOriginal && source.memoryId === null)
      ) ||
      !(
        typeof source.agentId === "string" ||
        (!isOriginal && source.agentId === null)
      ) ||
      (isOriginal && (!source.memoryId || !source.agentId)) ||
      typeof source.roomId !== "string" ||
      !source.roomId ||
      typeof source.entityId !== "string" ||
      !source.entityId ||
      !(
        source.createdAt === null ||
        (typeof source.createdAt === "number" &&
          Number.isFinite(source.createdAt))
      )
    )
      return;
    const identity = JSON.stringify([
      source.agentId,
      source.roomId,
      source.memoryId,
    ]);
    if (ids.has(source.id) || (isOriginal && identities.has(identity))) return;
    ids.add(source.id);
    if (isOriginal) identities.add(identity);
    sources.push({
      id: source.id,
      prefix: source.prefix,
      ...(isOriginal ? { originalText: body } : { text: body }),
      memoryId: source.memoryId,
      agentId: source.agentId,
      roomId: source.roomId,
      entityId: source.entityId,
      createdAt: source.createdAt,
    });
  }
  const messages = { header: value.header, sources };
  return renderProviderOriginalMessages(messages).trim() === text.trim()
    ? messages
    : undefined;
}

export function providerOriginals(context: ContextObject):
  | {
      sourceSetId: string;
      originals: ReadonlyMap<string, string>;
    }
  | undefined {
  const originals = new Map<string, string>();
  const bindings: unknown[] = [];
  const ids = new Set<string>();
  for (const [index, event] of context.events.entries()) {
    if (
      event.type !== "provider" ||
      !("name" in event) ||
      typeof event.text !== "string"
    )
      continue;
    const messages = readProviderOriginalMessages(
      event.text,
      isObjectRecord(event.data) ? event.data.originalMessages : undefined,
    );
    if (!messages) continue;
    for (const source of messages.sources) {
      if (ids.has(source.id)) return;
      ids.add(source.id);
      if (source.originalText !== undefined)
        originals.set(source.id, source.originalText);
    }
    bindings.push({
      index,
      id: event.id,
      name: event.name,
      source: event.source,
      text: event.text,
      messages,
    });
  }
  return originals.size
    ? {
        sourceSetId: hashStableJson({
          contextId: context.id,
          metadata: context.metadata,
          bindings,
        }),
        originals,
      }
    : undefined;
}
