/**
 * Text helpers that turn a completed FILE or SHELL operation into a short
 * human-readable summary line for action results. Pure string formatting, shared
 * by the file and bash actions.
 */
import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";

export function basename(path: string): string {
  return path.split("/").pop() || path;
}

export function compactSummaryText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const wellFormed = toWellFormedUnicode(normalized);
  if (wellFormed.length <= maxLength) return wellFormed;
  const budget = Math.max(0, maxLength - 1);
  return `${truncateWellFormed(wellFormed, budget).trimEnd()}…`;
}

export function summarizeFileOperation(
  params: Record<string, unknown>,
): string | undefined {
  const action = String(params.action ?? "").toLowerCase();
  const rawPath = params.file_path ?? params.path;
  const path = typeof rawPath === "string" ? basename(rawPath) : undefined;
  if (!path) return undefined;
  if (action === "write" || action === "create") {
    return `wrote ${path}`;
  }
  if (action === "edit") {
    return `edited ${path}`;
  }
  return undefined;
}

export function summarizeShellCommand(
  redactedCommand: unknown,
): string | undefined {
  const command = redactedCommand;
  if (typeof command !== "string" || command.trim().length === 0) {
    return undefined;
  }
  return `ran \`${compactSummaryText(command, 60)}\``;
}
