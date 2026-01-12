import type { Content, IAgentRuntime, Memory } from "@elizaos/core";
import { createUniqueUuid } from "@elizaos/core";

export function createMessageReply(
  runtime: IAgentRuntime,
  message: Memory,
  reply: string
): Content {
  return {
    text: reply,
    attachments: [],
    source: message.content.source ?? "",
    channelType: message.content.channelType,
    inReplyTo: createUniqueUuid(runtime, message.id ?? ""),
  };
}

export function extractUrls(text: string): string[] {
  const URL_MATCH = /(?:(?:https?|ftp):\/\/|www\.)[^\s<>"'`]+/gi;
  const candidates = text.match(URL_MATCH) || [];

  const results: string[] = [];
  const seen = new Set<string>();

  for (const raw of candidates) {
    const candidate = raw.replace(/^[([{<'"]+/, "");
    let withScheme = candidate.startsWith("www.") ? `http://${candidate}` : candidate;
    const TRAIL = /[)\]}>,.;!?:'"\u2026]$/;
    while (withScheme && TRAIL.test(withScheme.slice(-1)) && !isValidUrl(withScheme)) {
      withScheme = withScheme.slice(0, -1);
    }

    if (!isValidUrl(withScheme)) continue;

    const normalized = new URL(withScheme).toString();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      results.push(normalized);
    }
  }

  return results;
}

function isValidUrl(u: string): boolean {
  try {
    new URL(u);
    return true;
  } catch {
    return false;
  }
}

export function formatRelativeTime(timestamp: number): string {
  const timeSince = Date.now() - timestamp;
  const minutesSince = Math.floor(timeSince / 60000);
  const hoursSince = Math.floor(minutesSince / 60);
  const daysSince = Math.floor(hoursSince / 24);

  if (daysSince > 0) {
    return `${daysSince} day${daysSince > 1 ? "s" : ""} ago`;
  } else if (hoursSince > 0) {
    return `${hoursSince} hour${hoursSince > 1 ? "s" : ""} ago`;
  } else if (minutesSince > 0) {
    return `${minutesSince} minute${minutesSince > 1 ? "s" : ""} ago`;
  } else {
    return "just now";
  }
}
