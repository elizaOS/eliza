export function parseToonKeyValue<T = Record<string, unknown>>(
  text: string,
): T | null {
  const result: Record<string, unknown> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (
      !line ||
      line.startsWith("#") ||
      line.startsWith("```") ||
      !line.includes(":")
    ) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }
    result[key] = value.replace(/^["']|["']$/g, "");
  }

  return Object.keys(result).length > 0 ? (result as T) : null;
}
