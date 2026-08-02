/**
 * Render a NormalizedConversation to a markdown transcript, and split long
 * conversations into overlapping part-documents at message boundaries.
 *
 * Transcript format (scope §4.1):
 *
 *   # <title>  (imported from ChatGPT, 2024-05-01)
 *   **user** (2024-05-01 12:00): ...
 *   **assistant** (2024-05-01 12:01): ...
 *
 * Long conversations (> ~8k rendered tokens) split into part-documents at
 * message boundaries with a 1-2 message overlap so retrieval context is never
 * severed mid-exchange. Splitting returns an ordered array; a short
 * conversation returns a single part.
 */

import type {
  ConversationSource,
  NormalizedConversation,
  NormalizedMessage,
} from "./types.ts";

/** Approximate chars-per-token for the rough token budget used when splitting. */
const CHARS_PER_TOKEN = 4;

/** Default rendered-token budget per part before splitting kicks in. */
export const DEFAULT_MAX_PART_TOKENS = 8_000;

/** Default number of trailing messages repeated at the head of the next part. */
export const DEFAULT_OVERLAP_MESSAGES = 2;

/** Human-friendly source labels for the transcript header. */
const SOURCE_LABELS: Record<string, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  hermes: "Hermes",
  openclaw: "OpenClaw",
};

export interface RenderedPart {
  /** Full markdown transcript text for this part (includes the header). */
  text: string;
  /** 0-based part index. */
  index: number;
  /** Total number of parts the conversation was split into. */
  partCount: number;
  /** Number of messages rendered in this part (including overlap). */
  messageCount: number;
  /** Index (in the source `messages` array) of the first message in this part. */
  firstMessageIndex: number;
  /** Index (in the source `messages` array) of the last message in this part. */
  lastMessageIndex: number;
}

export interface RenderOptions {
  /** Rendered-token budget per part. Defaults to {@link DEFAULT_MAX_PART_TOKENS}. */
  maxPartTokens?: number;
  /** Overlap in messages between adjacent parts. Defaults to 2. */
  overlapMessages?: number;
}

function labelForSource(source: ConversationSource): string {
  return SOURCE_LABELS[source] ?? source;
}

/** Format an epoch-ms timestamp as `YYYY-MM-DD` (UTC). */
export function formatDate(epochMs?: number): string | undefined {
  if (epochMs === undefined || !Number.isFinite(epochMs)) {
    return undefined;
  }
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** Format an epoch-ms timestamp as `YYYY-MM-DD HH:MM` (UTC). */
export function formatDateTime(epochMs?: number): string | undefined {
  if (epochMs === undefined || !Number.isFinite(epochMs)) {
    return undefined;
  }
  const iso = new Date(epochMs).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** Build the `# title (imported from Source, date)` header line. */
export function renderHeader(
  conversation: NormalizedConversation,
  source: ConversationSource,
): string {
  const title = conversation.title?.trim() || "Untitled conversation";
  const label = labelForSource(source);
  const date = formatDate(conversation.createdAt ?? conversation.updatedAt);
  const suffix = date
    ? ` (imported from ${label}, ${date})`
    : ` (imported from ${label})`;
  return `# ${title}${suffix}`;
}

/** Render a single message to its `**role** (ts): text` block (+ attachments). */
export function renderMessage(message: NormalizedMessage): string {
  const ts = formatDateTime(message.createdAt);
  const head = ts ? `**${message.role}** (${ts}):` : `**${message.role}**:`;
  const body = message.text?.trim() ?? "";
  const lines: string[] = [];
  lines.push(body ? `${head} ${body}` : head);

  if (message.attachments?.length) {
    for (const att of message.attachments) {
      if (att.text?.trim()) {
        lines.push(`> [${att.kind}: ${att.name}]`);
        // Quote the extracted/inlined content so it reads as attached context.
        for (const line of att.text.trim().split("\n")) {
          lines.push(`> ${line}`);
        }
      } else {
        lines.push(`> [${att.kind}: ${att.name}]`);
      }
    }
  }
  return lines.join("\n");
}

/** Rough token estimate for a rendered string. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Render a conversation into one or more part-documents. A conversation whose
 * rendered body fits the token budget yields a single part; otherwise it is
 * split at message boundaries with the configured message overlap.
 *
 * Overlap semantics: each subsequent part re-includes the last
 * `overlapMessages` messages of the previous part at its head so a
 * question/answer pair is never severed across parts.
 */
export function renderConversation(
  conversation: NormalizedConversation,
  source: ConversationSource,
  options: RenderOptions = {},
): RenderedPart[] {
  const maxPartTokens = options.maxPartTokens ?? DEFAULT_MAX_PART_TOKENS;
  const overlapMessages = Math.max(
    0,
    options.overlapMessages ?? DEFAULT_OVERLAP_MESSAGES,
  );
  const header = renderHeader(conversation, source);
  const headerTokens = estimateTokens(header);

  const messages = conversation.messages ?? [];
  const rendered = messages.map((m) => renderMessage(m));
  const renderedTokens = rendered.map((r) => estimateTokens(r));

  // Group message indices into parts under the token budget.
  const groups: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor < messages.length) {
    let budget = maxPartTokens - headerTokens;
    let end = cursor;
    // Always include at least one message, even if it alone exceeds budget.
    while (end < messages.length) {
      const cost = renderedTokens[end] + 1; // +1 for the blank-line separator
      if (end > cursor && cost > budget) {
        break;
      }
      budget -= cost;
      end += 1;
    }
    groups.push({ start: cursor, end }); // end is exclusive
    if (end >= messages.length) {
      break;
    }
    // Next part starts `overlapMessages` before the boundary (never before the
    // current start, so we always make forward progress).
    cursor = Math.max(cursor + 1, end - overlapMessages);
  }

  // Empty conversation → single header-only part.
  if (groups.length === 0) {
    return [
      {
        text: header,
        index: 0,
        partCount: 1,
        messageCount: 0,
        firstMessageIndex: 0,
        lastMessageIndex: -1,
      },
    ];
  }

  const partCount = groups.length;
  const partSuffix = partCount > 1;

  return groups.map((group, index) => {
    const slice = rendered.slice(group.start, group.end);
    const headerLine = partSuffix
      ? `${header}  · part ${index + 1}/${partCount}`
      : header;
    const text = [headerLine, "", ...slice]
      .join("\n\n")
      .replace(/\n{3,}/g, "\n\n");
    return {
      text,
      index,
      partCount,
      messageCount: group.end - group.start,
      firstMessageIndex: group.start,
      lastMessageIndex: group.end - 1,
    };
  });
}
