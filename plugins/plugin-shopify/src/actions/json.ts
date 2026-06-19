export function parseJsonObject<T extends Record<string, unknown>>(
  value: string,
): T | null {
  try {
    const parsed: unknown = JSON.parse(value.trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as T)
      : null;
  } catch {
    return null;
  }
}
