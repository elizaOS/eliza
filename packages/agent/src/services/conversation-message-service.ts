/**
 * Owns conversation-message deletion and truncation against the runtime
 * persistence contract. HTTP routes supply an authorized conversation and
 * translate the service's status-bearing not-found error at their boundary.
 */
import {
  type AgentRuntime,
  buildAccessContext,
  compareMemoryIds,
  ElizaError,
  MESSAGE_CONTENT_SEGMENT_MAX_BYTES,
  type Memory,
  messageTextSourceDescriptor,
  replaceStoredMessageContent,
  sanitizeSpeechText,
  type UUID,
} from "@elizaos/core";
import type { ConversationMeta } from "../api/server-types.ts";

type DeletableRuntime = AgentRuntime & {
  deleteManyMemories?: (memoryIds: UUID[]) => Promise<unknown>;
  deleteMemory?: (memoryId: UUID) => Promise<unknown>;
  removeMemory?: (memoryId: UUID) => Promise<unknown>;
  adapter: AgentRuntime["adapter"] & {
    db: {
      deleteManyMemories?: (memoryIds: UUID[]) => Promise<unknown>;
      deleteMemory?: (memoryId: UUID) => Promise<unknown>;
      removeMemory?: (memoryId: UUID) => Promise<unknown>;
    };
  };
};

function conversationMessageNotFound(): Error & { status: number } {
  return Object.assign(new Error("Conversation message not found"), {
    status: 404,
  });
}

export async function deleteConversationMemories(
  runtime: AgentRuntime,
  memoryIds: UUID[],
): Promise<number> {
  if (memoryIds.length === 0) return 0;
  const deletable = runtime as DeletableRuntime;
  // The canonical runtime boundary also retires derived source evidence and
  // invalidates room reads. A direct adapter delete bypasses those guarantees.
  if (typeof runtime.deleteMemories === "function") {
    await runtime.deleteMemories(memoryIds);
    return memoryIds.length;
  }
  if (typeof deletable.deleteManyMemories === "function") {
    await deletable.deleteManyMemories(memoryIds);
    return memoryIds.length;
  }
  if (typeof deletable.adapter.db.deleteManyMemories === "function") {
    await deletable.adapter.db.deleteManyMemories(memoryIds);
    return memoryIds.length;
  }

  if (memoryIds.length > 1) {
    throw Object.assign(
      new ElizaError(
        "Atomic conversation message deletion is not supported by this adapter",
        { code: "CONVERSATION_BULK_DELETE_UNAVAILABLE" },
      ),
      { status: 501 },
    );
  }

  for (const memoryId of memoryIds) {
    if (typeof deletable.deleteMemory === "function") {
      await deletable.deleteMemory(memoryId);
    } else if (typeof deletable.removeMemory === "function") {
      await deletable.removeMemory(memoryId);
    } else if (typeof deletable.adapter.db.deleteMemory === "function") {
      await deletable.adapter.db.deleteMemory(memoryId);
    } else if (typeof deletable.adapter.db.removeMemory === "function") {
      await deletable.adapter.db.removeMemory(memoryId);
    } else {
      throw Object.assign(
        new Error("Conversation message deletion is not supported"),
        { status: 501 },
      );
    }
  }
  return memoryIds.length;
}

const CONVERSATION_SCAN_PAGE_SIZE = 500;

function memoryCursor(memory: Memory): { createdAt: number; id: UUID } {
  if (
    typeof memory.id !== "string" ||
    memory.id.length === 0 ||
    !Number.isFinite(memory.createdAt)
  ) {
    throw new ElizaError("Conversation traversal returned an unpageable row", {
      code: "CONVERSATION_TRAVERSAL_INVALID_ROW",
    });
  }
  return { createdAt: memory.createdAt as number, id: memory.id };
}

function cursorFollows(
  next: { createdAt: number; id: UUID },
  previous: { createdAt: number; id: UUID },
): boolean {
  return (
    next.createdAt > previous.createdAt ||
    (next.createdAt === previous.createdAt &&
      compareMemoryIds(next.id, previous.id) > 0)
  );
}

async function getCompleteConversationMemories(
  runtime: AgentRuntime,
  roomId: UUID,
): Promise<Memory[]> {
  const complete: Memory[] = [];
  let cursor: { createdAt: number; id: UUID } | undefined;

  while (true) {
    const page = await runtime.getMemories({
      roomId,
      tableName: "messages",
      limit: CONVERSATION_SCAN_PAGE_SIZE,
      orderBy: "createdAt",
      orderDirection: "asc",
      ...(cursor ? { cursor } : {}),
    });
    if (page.length > CONVERSATION_SCAN_PAGE_SIZE) {
      throw new ElizaError(
        "Conversation traversal exceeded its requested page",
        {
          code: "CONVERSATION_TRAVERSAL_INVALID_PAGE",
          context: {
            requested: CONVERSATION_SCAN_PAGE_SIZE,
            received: page.length,
          },
        },
      );
    }
    for (const memory of page) {
      const next = memoryCursor(memory);
      if (cursor && !cursorFollows(next, cursor)) {
        throw new ElizaError("Conversation traversal did not advance", {
          code: "CONVERSATION_TRAVERSAL_UNSTABLE",
          context: { previousId: cursor.id, nextId: next.id },
        });
      }
      complete.push(memory);
      cursor = next;
    }
    if (page.length < CONVERSATION_SCAN_PAGE_SIZE) return complete;
  }
}

export async function deleteConversationMessage(
  runtime: AgentRuntime,
  conversation: ConversationMeta,
  messageId: string,
): Promise<{ deletedCount: number }> {
  const [memory] = await runtime.getMemoriesByIds(
    [messageId as UUID],
    "messages",
  );
  // A cross-room id is indistinguishable from absence so callers cannot use
  // this endpoint to confirm foreign message existence.
  if (!memory || memory.roomId !== conversation.roomId) {
    throw conversationMessageNotFound();
  }
  return {
    deletedCount: await deleteConversationMemories(runtime, [
      messageId as UUID,
    ]),
  };
}

export async function truncateConversationMessages(
  runtime: AgentRuntime,
  conversation: ConversationMeta,
  messageId: string,
  options?: { inclusive?: boolean },
): Promise<{ deletedCount: number }> {
  const memories = await getCompleteConversationMemories(
    runtime,
    conversation.roomId,
  );
  const targetIndex = memories.findIndex((memory) => memory.id === messageId);
  if (targetIndex < 0) throw conversationMessageNotFound();
  const start = options?.inclusive === true ? targetIndex : targetIndex + 1;
  const memoryIds = memories
    .slice(start)
    .map((memory) => memory.id)
    .filter(
      (memoryId): memoryId is UUID =>
        typeof memoryId === "string" && memoryId.trim().length > 0,
    );
  return {
    deletedCount: await deleteConversationMemories(runtime, memoryIds),
  };
}

/** Compare reply text with whitespace runs collapsed, as speech output does. */
function spokenComparable(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function heardTextConflict(): Error & { status: number } {
  return Object.assign(
    new ElizaError(
      "Heard text must be a prefix of the stored assistant reply or of its spoken form",
      { code: "CONVERSATION_HEARD_NOT_PREFIX" },
    ),
    { status: 409 },
  );
}

/**
 * Map a heard prefix of the spoken form (`sanitizeSpeechText`, which drops
 * markdown, URLs, code and stage directions) back to the shortest stored-text
 * prefix, cut at a word end, whose spoken form starts with it. A heard word
 * cut mid-way keeps the whole stored word. Returns null when no stored prefix
 * speaks the heard text.
 */
function storedPrefixForSpokenText(
  stored: string,
  heardComparable: string,
): string | null {
  const cuts: number[] = [];
  for (let i = 1; i < stored.length; i += 1) {
    if (/\s/.test(stored[i] ?? "") && !/\s/.test(stored[i - 1] ?? "")) {
      cuts.push(i);
    }
  }
  cuts.push(stored.length);
  const spoken = (cut: number) =>
    spokenComparable(sanitizeSpeechText(stored.slice(0, cut)));
  // Spoken length grows with the stored prefix, so bisect for the first cut
  // that speaks at least as much as was heard.
  let low = 0;
  let high = cuts.length - 1;
  if (spoken(cuts[high] ?? 0).length < heardComparable.length) return null;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (spoken(cuts[middle] ?? 0).length >= heardComparable.length) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  const cut = cuts[low] ?? stored.length;
  if (spoken(cut).startsWith(heardComparable)) {
    return stored.slice(0, cut).trimEnd();
  }

  // Closing a stage direction or another stripped block can make the spoken
  // length shrink, so the bisection can land inside text that TTS never says.
  // Mark every word boundary and sanitize once more. Markers inside stripped
  // blocks disappear with those blocks; surviving markers map the complete
  // spoken form back to its source without an O(words * text) prefix scan.
  let marker = "ElizaSpeechWordBoundary";
  while (stored.includes(marker)) marker += "X";
  const markedParts: string[] = [];
  let previous = 0;
  for (const [index, sourceCut] of cuts.entries()) {
    let insertion = sourceCut;
    while (insertion < stored.length && /\s/.test(stored[insertion] ?? "")) {
      insertion += 1;
    }
    markedParts.push(
      stored.slice(previous, insertion),
      ` ${marker}${index.toString(36)} `,
    );
    previous = insertion;
  }
  markedParts.push(stored.slice(previous));

  const boundaryPattern = new RegExp(`^${marker}([0-9a-z]+)$`);
  const boundaryLengths = new Map<number, number>();
  const visibleTokens: string[] = [];
  let visibleLength = 0;
  for (const token of sanitizeSpeechText(markedParts.join("")).split(/\s+/)) {
    const boundary = boundaryPattern.exec(token);
    if (boundary) {
      boundaryLengths.set(
        Number.parseInt(boundary[1] ?? "", 36),
        visibleLength,
      );
      continue;
    }
    if (!token) continue;
    if (visibleLength > 0) visibleLength += 1;
    visibleLength += token.length;
    visibleTokens.push(token);
  }
  if (visibleTokens.join(" ") !== spoken(cuts.at(-1) ?? 0)) return null;
  for (const [index, sourceCut] of cuts.entries()) {
    if ((boundaryLengths.get(index) ?? -1) >= heardComparable.length) {
      return stored.slice(0, sourceCut).trimEnd();
    }
  }
  return null;
}

/**
 * The complete stored text of a message. Text over the inline limit lives in
 * content segments; read them page by page at one revision.
 */
async function readStoredMessageText(
  runtime: AgentRuntime,
  memory: Memory & { id: UUID },
): Promise<string> {
  if (typeof memory.content.text === "string") return memory.content.text;
  if (!messageTextSourceDescriptor(memory.content)) return "";
  const read = runtime.adapter.readMessageContentRange;
  if (!read) {
    throw new ElizaError("Message store cannot read segmented content", {
      code: "MESSAGE_CONTENT_SEGMENT_STORAGE_UNAVAILABLE",
      context: { messageId: memory.id },
    });
  }
  const accessContext = await buildAccessContext(runtime, memory);
  const parts: string[] = [];
  let offset = 0;
  let revision: string | undefined;
  while (true) {
    const result = await read.call(runtime.adapter, {
      agentId: runtime.agentId,
      messageId: memory.id,
      authorizedRoomId: memory.roomId,
      accessContext,
      source: { kind: "message-text" },
      offset,
      limit: MESSAGE_CONTENT_SEGMENT_MAX_BYTES,
      ...(revision ? { expectedRevision: revision } : {}),
    });
    if (result.status === "inline") return result.text;
    if (result.status !== "ok") throw conversationMessageNotFound();
    revision = result.page.revision;
    parts.push(result.page.text);
    if (result.page.end >= result.page.total || result.page.end <= offset) {
      return parts.join("");
    }
    offset = result.page.end;
  }
}

/**
 * Keep only the part of a stored assistant reply that the user heard before
 * they interrupted playback. `heardText` must be non-empty and either a prefix
 * of the stored text or a prefix of its spoken form (`sanitizeSpeechText`);
 * whitespace runs compare as one space. A spoken-form prefix is stored as the
 * matching stored-text prefix, so the reply keeps its written form and can
 * only get shorter. Repeating the same request returns the same result
 * without a second write. The trimmed reply is marked `interrupted` and
 * `heardTruncated`, written through the segment-aware content replacement,
 * and re-embedded so semantic search no longer matches the unheard text.
 */
export async function recordHeardAssistantMessage(
  runtime: AgentRuntime,
  conversation: ConversationMeta,
  messageId: UUID,
  heardText: string,
): Promise<{ text: string; truncated: boolean; changed: boolean }> {
  const [memory] = await runtime.getMemoriesByIds([messageId], "messages");
  if (!memory?.id || memory.roomId !== conversation.roomId) {
    throw conversationMessageNotFound();
  }
  if (
    memory.entityId !== runtime.agentId ||
    memory.agentId !== runtime.agentId
  ) {
    throw Object.assign(
      new ElizaError("Only assistant replies can record heard text", {
        code: "CONVERSATION_HEARD_NOT_ASSISTANT",
      }),
      { status: 400 },
    );
  }
  const stored = await readStoredMessageText(runtime, {
    ...memory,
    id: memory.id,
  });
  const storedComparable = spokenComparable(stored);
  const heardComparable = spokenComparable(heardText);
  if (!heardComparable) {
    throw Object.assign(
      new ElizaError("heardText must not be empty", {
        code: "CONVERSATION_HEARD_EMPTY",
      }),
      { status: 400 },
    );
  }
  const alreadyTruncated = memory.content.heardTruncated === true;
  const unchanged = {
    text: stored,
    truncated: alreadyTruncated,
    changed: false,
  };
  let text: string;
  if (storedComparable.startsWith(heardComparable)) {
    if (heardComparable === storedComparable) return unchanged;
    text = heardText.trim();
  } else {
    const spokenStored = spokenComparable(sanitizeSpeechText(stored));
    if (heardComparable === spokenStored) return unchanged;
    const prefix = spokenStored.startsWith(heardComparable)
      ? storedPrefixForSpokenText(stored, heardComparable)
      : null;
    if (prefix === null) throw heardTextConflict();
    if (spokenComparable(prefix) === storedComparable) return unchanged;
    text = prefix;
  }
  // The new text is inline; drop the full reply's segment manifest so its
  // segments are removed.
  const { messageTextSource: _fullReplySource, ...storedContent } =
    memory.content;
  const content = {
    ...storedContent,
    text,
    interrupted: true,
    heardTruncated: true,
  };
  await replaceStoredMessageContent(runtime, memory.id, content);
  // The stored vector still describes the full reply. Queue a new one for the
  // heard text; the embedding service overwrites the old vector.
  const { embedding: _staleEmbedding, ...rest } = memory;
  await runtime.queueEmbeddingGeneration(
    { ...rest, id: memory.id, content },
    "normal",
  );
  return { text, truncated: true, changed: true };
}
