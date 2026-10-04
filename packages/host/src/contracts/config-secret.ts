/** Treat blank and redacted configuration placeholders as absent. */
export function normalizeSecretString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.toUpperCase() === "[REDACTED]") {
    return undefined;
  }
  return trimmed;
}
