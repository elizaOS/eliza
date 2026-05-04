const DOCS_ROOT = "https://docs.eliza.ai";

export function formatTerminalLink(
  label: string,
  url: string,
  opts?: { fallback?: string; force?: boolean },
): string {
  const safeLabel = label.replaceAll("\u001b", "");
  const safeUrl = url.replaceAll("\u001b", "");
  const allow = opts?.force ?? Boolean(process.stdout.isTTY);
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
  const trimmed = path.trim();
  const url = trimmed.startsWith("http")
    ? trimmed
    : `${DOCS_ROOT}${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`;
  return formatTerminalLink(label ?? url, url, {
    fallback: opts?.fallback ?? url,
    force: opts?.force,
  });
}
