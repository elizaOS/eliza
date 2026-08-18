/**
 * Formats OSC-8 terminal hyperlinks for CLI output, falling back to `label
 * (url)` when stdout is not a TTY. Strips ESC bytes from label/url so untrusted
 * values cannot inject escape sequences.
 */
const DOCS_ROOT = "https://docs.eliza.ai";

export function formatTerminalLink(
  label: string,
  url: string,
  opts?: { fallback?: string; force?: boolean },
): string {
  const safeLabel =
    typeof label === "string"
      ? label.replaceAll("\u001b", "")
      : String(label ?? "");
  const safeUrl =
    typeof url === "string" ? url.replaceAll("\u001b", "") : String(url ?? "");
  const isTty =
    typeof process !== "undefined" && Boolean(process.stdout?.isTTY);
  const allow = opts?.force ?? isTty;
  if (!allow) {
    return opts?.fallback ?? `${safeLabel} (${safeUrl})`;
  }
  return `\u001b]8;;${safeUrl}\u0007${safeLabel}\u001b]8;;\u0007`;
}

export function formatDocsLink(
  path: string,
  label?: string,
  opts?: { fallback?: string; force?: boolean },
): string {
  const rawPath = typeof path === "string" ? path : String(path ?? "");
  const trimmed = rawPath.trim();
  const url = trimmed.startsWith("http")
    ? trimmed
    : `${DOCS_ROOT}${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`;
  return formatTerminalLink(label ?? url, url, {
    fallback: opts?.fallback ?? (label ? undefined : url),
    force: opts?.force,
  });
}
