export function normalizeHttpBaseUrl(
  value: unknown,
  defaultValue: string | null = null,
): string | null {
  const trimmed =
    typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  if (!trimmed) {
    return defaultValue;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function normalizeHttpOrigin(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.origin.replace(/\/+$/, "");
  } catch {
    return null;
  }
}
