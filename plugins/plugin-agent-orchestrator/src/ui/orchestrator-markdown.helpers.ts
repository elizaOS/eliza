// Pure markdown URL sanitizer, split out of orchestrator-markdown.tsx so that
// file exports only the MarkdownText component and stays Fast-Refresh-compatible.
// Returns the URL only for safe schemes/relative forms, null otherwise — keeping
// raw/unknown-scheme links (javascript:, data:, …) out of the rendered AST.
export function sanitizeMarkdownUrl(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (
    (trimmed.startsWith("/") && !trimmed.startsWith("//")) ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("#")
  ) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:" ||
      parsed.protocol === "mailto:"
    ) {
      return trimmed;
    }
  } catch {
    return null;
  }

  return null;
}
