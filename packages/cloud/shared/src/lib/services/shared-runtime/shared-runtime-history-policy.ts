/**
 * Side-effect-free history policy shared by Worker Durable Objects and the
 * canonical Postgres repository. Both stores use this exact merge so a late
 * mirror, retry, or direct writer converges instead of replacing newer turns.
 */

export const MAX_HISTORY_MESSAGES = 40;

export interface SharedRuntimeHistoryMessageLike {
  id?: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: number;
  interrupted?: boolean;
  actionResults?: Array<{
    actionName?: string;
    success: boolean;
    text?: string;
    error?: string;
    values?: Record<string, unknown>;
  }>;
}

function isPersistedMessage(value: unknown): value is SharedRuntimeHistoryMessageLike {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    ((value as { role?: unknown }).role === "user" ||
      (value as { role?: unknown }).role === "assistant") &&
    typeof (value as { content?: unknown }).content === "string" &&
    (value as { content: string }).content.trim().length > 0
  );
}

function messageIdentity(message: SharedRuntimeHistoryMessageLike): string {
  return message.id ?? `${message.role}\u0000${message.createdAt ?? ""}\u0000${message.content}`;
}

function chooseMergedMessage<T extends SharedRuntimeHistoryMessageLike>(
  current: T | undefined,
  incoming: T,
): T {
  if (!current) return incoming;
  if (
    current.role === "assistant" &&
    incoming.role === "assistant" &&
    current.interrupted !== true &&
    incoming.interrupted === true
  ) {
    return current;
  }
  if (
    current.role === "assistant" &&
    incoming.role === "assistant" &&
    current.interrupted === true &&
    incoming.interrupted === true &&
    current.content.length > incoming.content.length
  ) {
    return current;
  }
  return incoming;
}

export function mergeSharedRuntimeHistoryMessages<T extends SharedRuntimeHistoryMessageLike>(
  current: T[],
  incoming: T[],
  limit: number,
): T[] {
  const merged = new Map<string, T>();
  for (const message of [...current, ...incoming]) {
    if (!isPersistedMessage(message)) continue;
    const key = messageIdentity(message);
    merged.set(key, chooseMergedMessage(merged.get(key), message));
  }
  return [...merged.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)).slice(-limit);
}
