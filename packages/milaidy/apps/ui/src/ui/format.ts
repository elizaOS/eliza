export function formatMs(ms?: number | null): string {
  if (!ms && ms !== 0) {
    return "n/a";
  }
  return new Date(ms).toLocaleString();
}

export function formatAgo(ms?: number | null): string {
  if (!ms && ms !== 0) {
    return "n/a";
  }
  const diff = Date.now() - ms;
  const absDiff = Math.abs(diff);
  const suffix = diff < 0 ? "from now" : "ago";
  const sec = Math.round(absDiff / 1000);
  if (sec < 60) {
    return diff < 0 ? "just now" : `${sec}s ago`;
  }
  const min = Math.round(sec / 60);
  if (min < 60) {
    return `${min}m ${suffix}`;
  }
  const hr = Math.round(min / 60);
  if (hr < 48) {
    return `${hr}h ${suffix}`;
  }
  const day = Math.round(hr / 24);
  return `${day}d ${suffix}`;
}

export function formatDurationMs(ms?: number | null): string {
  if (!ms && ms !== 0) {
    return "n/a";
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const sec = Math.round(ms / 1000);
  if (sec < 60) {
    return `${sec}s`;
  }
  const min = Math.round(sec / 60);
  if (min < 60) {
    return `${min}m`;
  }
  const hr = Math.round(min / 60);
  if (hr < 48) {
    return `${hr}h`;
  }
  const day = Math.round(hr / 24);
  return `${day}d`;
}

export function formatList(values?: Array<string | null | undefined>): string {
  if (!values || values.length === 0) {
    return "none";
  }
  return values.filter((v): v is string => Boolean(v && v.trim())).join(", ");
}

export function clampText(value: string, max = 120): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function truncateText(
  value: string,
  max: number,
): {
  text: string;
  truncated: boolean;
  total: number;
} {
  if (value.length <= max) {
    return { text: value, truncated: false, total: value.length };
  }
  return {
    text: value.slice(0, Math.max(0, max)),
    truncated: true,
    total: value.length,
  };
}

export function toNumber(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function parseList(input: string): string[] {
  return input
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * Strips reasoning/thinking tags from text.
 * - <think>...</think> and <thinking>...</thinking> segments are fully removed
 * - <final>...</final> tags are removed but content is preserved
 * - Unpaired opening tags (e.g., mid-stream) are removed, content is kept
 * - Unpaired closing tags are removed
 */
export function stripThinkingTags(value: string): string {
  let result = value;
  
  // Remove <think>...</think> segments entirely (content and tags)
  result = result.replace(/<think>[\s\S]*?<\/think>/gi, "");
  
  // Remove <thinking>...</thinking> segments entirely (content and tags)
  result = result.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  
  // For <final>...</final>, keep content but remove tags
  result = result.replace(/<final>([\s\S]*?)<\/final>/gi, (_match, content) => content.trimStart());
  
  // Handle unpaired opening tags (streaming case) - remove tag only
  result = result.replace(/<(think|thinking)>\n?/gi, "");
  
  // Handle unpaired closing tags - remove them
  result = result.replace(/<\/(think|thinking|final)>/gi, "");
  
  // Trim leading whitespace
  return result.trimStart();
}
