/**
 * Chat helpers — streaming delta computation, formatting, and common patterns.
 *
 * Extracted from AppContext to be reusable across providers.
 */

import {
  computeStreamingDelta as computeStreamingDeltaInternal,
  mergeStreamingText,
} from "../utils/streaming-text";

export { mergeStreamingText };

/**
 * Compute the streaming delta between the accumulated text and the new token.
 * The SSE endpoint may emit the full text so far or just the delta — this
 * function handles both by returning only the new characters.
 */
export function computeStreamingDelta(
  accumulated: string,
  token: string,
): string {
  return computeStreamingDeltaInternal(accumulated, token);
}

/**
 * Determine whether the final stream response text should replace the
 * accumulated text in the UI. This handles cases where the final text
 * differs from what was streamed (e.g., post-processing on the server).
 */
export function shouldApplyFinalStreamText(
  streamed: string,
  final: string,
): boolean {
  if (!final) return false;
  return final !== streamed;
}

/**
 * Format a search result section with a label and bullet items.
 */
export function formatSearchBullet(label: string, items: string[]): string {
  if (items.length === 0) return `**${label}**: (none)`;
  return `**${label}**:\n${items.map((item) => `• ${item}`).join("\n")}`;
}

/**
 * Parse slash command input into a command name and raw arguments.
 */
export function parseSlashCommandInput(
  rawText: string,
): { name: string; argsRaw: string } | null {
  if (!rawText.startsWith("/")) return null;
  const rest = rawText.slice(1);
  const spaceIdx = rest.indexOf(" ");
  if (spaceIdx < 0) {
    return { name: rest.toLowerCase(), argsRaw: "" };
  }
  return {
    name: rest.slice(0, spaceIdx).toLowerCase(),
    argsRaw: rest.slice(spaceIdx + 1),
  };
}

/**
 * Normalize a custom action name for slash command matching.
 */
export function normalizeCustomActionName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * Parse custom action params from a slash command args string.
 */
export function parseCustomActionParams(
  action: { params?: Array<{ name: string; required?: boolean }> },
  argsRaw: string,
): { params: Record<string, string>; missingRequired: string[] } {
  const params: Record<string, string> = {};
  const missingRequired: string[] = [];

  if (!action.params || action.params.length === 0) {
    if (argsRaw.trim()) {
      params.input = argsRaw.trim();
    }
    return { params, missingRequired };
  }

  const tokens = argsRaw.trim().split(/\s+/);
  for (let i = 0; i < action.params.length; i++) {
    const param = action.params[i];
    if (i < tokens.length && tokens[i]) {
      params[param.name] = tokens[i];
    } else if (param.required) {
      missingRequired.push(param.name);
    }
  }

  return { params, missingRequired };
}
