/**
 * Formats OSC-8 terminal hyperlinks for CLI output, falling back to `label
 * (url)` when stdout is not a TTY. Removes C0/DEL control bytes from label and
 * URL values so untrusted text cannot terminate or inject terminal sequences.
 */
const DOCS_ROOT = "https://docs.eliza.ai";
function stripTerminalControlBytes(value: string): string {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f;
    })
    .join("");
}

export function formatTerminalLink(
  label: string,
  url: string,
  opts?: { fallback?: string; force?: boolean },
): string {
  const safeLabel = stripTerminalControlBytes(label);
  const safeUrl = stripTerminalControlBytes(url);
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
