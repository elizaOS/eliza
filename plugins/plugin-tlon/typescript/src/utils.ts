import { formatShip, normalizeShip } from "./environment";
import type { TlonInline, TlonStory, TlonVerse } from "./types";

/**
 * Interface for poke API (subset of TlonClient)
 */
export interface TlonPokeApi {
  poke: (params: {
    app: string;
    mark: string;
    json: unknown;
  }) => Promise<unknown>;
}

/**
 * Format a number as Urbit @ud (with dots)
 */
export function formatUd(n: bigint): string {
  const str = n.toString();
  const parts: string[] = [];
  for (let i = str.length; i > 0; i -= 3) {
    parts.unshift(str.slice(Math.max(0, i - 3), i));
  }
  return parts.join(".");
}

/**
 * Convert Unix timestamp (ms) to Urbit @da
 */
export function unixToUrbitDa(unixMs: number): bigint {
  // Urbit epoch is ~292.277.024.400 years before Unix epoch
  // This is the offset in 2^-64 second units
  const URBIT_EPOCH_OFFSET = BigInt("170141184475152167957503069145530368000");
  const msToUrbitUnits = BigInt(2 ** 64) / BigInt(1000);
  return BigInt(unixMs) * msToUrbitUnits + URBIT_EPOCH_OFFSET;
}

/**
 * Generate a Urbit-style message ID
 */
export function generateMessageId(ship: string, timestamp: number): string {
  const da = unixToUrbitDa(timestamp);
  const udStr = formatUd(da);
  return `${formatShip(ship)}/${udStr}`;
}

/**
 * Parameters for sending a DM
 */
interface SendDmParams {
  api: TlonPokeApi;
  fromShip: string;
  toShip: string;
  text: string;
}

/**
 * Send a direct message to another ship
 */
export async function sendDm({
  api,
  fromShip,
  toShip,
  text,
}: SendDmParams): Promise<{ channel: string; messageId: string }> {
  const story: TlonStory = [{ inline: [text] }];
  const sentAt = Date.now();
  const da = unixToUrbitDa(sentAt);
  const idUd = formatUd(da);
  const id = `${formatShip(fromShip)}/${idUd}`;

  const delta = {
    add: {
      memo: {
        content: story,
        author: formatShip(fromShip),
        sent: sentAt,
      },
      kind: null,
      time: null,
    },
  };

  const action = {
    ship: formatShip(toShip),
    diff: { id, delta },
  };

  await api.poke({
    app: "chat",
    mark: "chat-dm-action",
    json: action,
  });

  return { channel: "tlon", messageId: id };
}

/**
 * Parameters for sending a group message
 */
interface SendGroupParams {
  api: TlonPokeApi;
  fromShip: string;
  hostShip: string;
  channelName: string;
  text: string;
  replyToId?: string | null;
}

/**
 * Send a message to a group channel
 */
export async function sendGroupMessage({
  api,
  fromShip,
  hostShip,
  channelName,
  text,
  replyToId,
}: SendGroupParams): Promise<{ channel: string; messageId: string }> {
  const story: TlonStory = [{ inline: [text] }];
  const sentAt = Date.now();

  // Format reply ID as @ud (with dots) - required for Tlon to recognize thread replies
  let formattedReplyId = replyToId;
  if (replyToId && /^\d+$/.test(replyToId)) {
    try {
      formattedReplyId = formatUd(BigInt(replyToId));
    } catch {
      // Fall back to raw ID if formatting fails
    }
  }

  const action = {
    channel: {
      nest: `chat/${formatShip(hostShip)}/${channelName}`,
      action: formattedReplyId
        ? {
            // Thread reply - needs post wrapper around reply action
            post: {
              reply: {
                id: formattedReplyId,
                action: {
                  add: {
                    content: story,
                    author: formatShip(fromShip),
                    sent: sentAt,
                  },
                },
              },
            },
          }
        : {
            // Regular post
            post: {
              add: {
                content: story,
                author: formatShip(fromShip),
                sent: sentAt,
                kind: "/chat",
                blob: null,
                meta: null,
              },
            },
          },
    },
  };

  await api.poke({
    app: "channels",
    mark: "channel-action-1",
    json: action,
  });

  return { channel: "tlon", messageId: `${formatShip(fromShip)}/${sentAt}` };
}

/**
 * Extract plain text from Tlon story/content format
 */
export function extractMessageText(content: unknown): string {
  if (!content) return "";

  // Handle array format (story)
  if (Array.isArray(content)) {
    return content
      .map((verse) => {
        if (typeof verse === "string") return verse;
        if (verse && typeof verse === "object") {
          return extractVerseText(verse as TlonVerse);
        }
        return "";
      })
      .join("\n")
      .trim();
  }

  // Handle object format
  if (typeof content === "object") {
    return extractVerseText(content as TlonVerse);
  }

  return String(content);
}

/**
 * Extract text from a verse element
 */
function extractVerseText(verse: TlonVerse): string {
  const parts: string[] = [];

  if (verse.inline) {
    parts.push(extractInlineText(verse.inline));
  }

  if (verse.block) {
    if (verse.block.code) {
      parts.push(
        `\`\`\`${verse.block.code.lang || ""}\n${verse.block.code.code}\n\`\`\``,
      );
    }
    if (verse.block.image) {
      parts.push(`[Image: ${verse.block.image.alt || verse.block.image.src}]`);
    }
    if (verse.block.header) {
      parts.push(extractInlineText(verse.block.header.content));
    }
    if (verse.block.listing) {
      const prefix = verse.block.listing.type === "ordered" ? "1." : "-";
      parts.push(
        verse.block.listing.items
          .map((item) => `${prefix} ${extractInlineText(item)}`)
          .join("\n"),
      );
    }
  }

  return parts.join("\n");
}

/**
 * Extract text from inline content
 */
function extractInlineText(inlines: TlonInline[]): string {
  return inlines
    .map((inline) => {
      if (typeof inline === "string") return inline;
      if (inline && typeof inline === "object") {
        if (inline.ship) return formatShip(inline.ship);
        if (inline.link) return `[${inline.link.content}](${inline.link.href})`;
        if (inline.bold) return extractInlineText(inline.bold);
        if (inline.italic) return extractInlineText(inline.italic);
        if (inline.strike) return extractInlineText(inline.strike);
        if (inline.code) return `\`${inline.code}\``;
        if (inline.blockquote)
          return `> ${extractInlineText(inline.blockquote)}`;
      }
      return "";
    })
    .join("");
}

/**
 * Build message text combining text and optional media URL
 */
export function buildMediaText(
  text: string | undefined,
  mediaUrl: string | undefined,
): string {
  const cleanText = text?.trim() ?? "";
  const cleanUrl = mediaUrl?.trim() ?? "";
  if (cleanText && cleanUrl) {
    return `${cleanText}\n${cleanUrl}`;
  }
  if (cleanUrl) {
    return cleanUrl;
  }
  return cleanText;
}

/**
 * Check if a ship is mentioned in the message text
 */
export function isBotMentioned(text: string, botShip: string): boolean {
  const normalizedBot = normalizeShip(botShip);
  const patterns = [
    new RegExp(`~${normalizedBot}\\b`, "i"),
    new RegExp(`@${normalizedBot}\\b`, "i"),
    new RegExp(`\\b${normalizedBot}\\b`, "i"),
  ];
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Check if a ship is in the DM allowlist
 */
export function isDmAllowed(ship: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const normalized = normalizeShip(ship);
  return allowlist.some((allowed) => normalizeShip(allowed) === normalized);
}
