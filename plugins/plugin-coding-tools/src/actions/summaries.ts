/**
 * Text helpers that turn a completed FILE or SHELL operation into a short
 * human-readable summary line for action results. Pure string formatting, shared
 * by the file and bash actions.
 */
export function basename(path: string): string {
  return path.split("/").pop() || path;
}

export function compactSummaryText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
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
  params: Record<string, unknown>,
): string | undefined {
  const command = params.command;
  if (typeof command !== "string" || command.trim().length === 0) {
    return undefined;
  }
  return `ran \`${compactSummaryText(command, 60)}\``;
}
