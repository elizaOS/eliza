export function normalizeEnvPrefix(value) {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  if (!normalized) {
    throw new Error("App envPrefix must resolve to a non-empty identifier");
  }
  return normalized;
}
