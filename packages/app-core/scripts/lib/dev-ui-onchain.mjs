/**
 * dev-ui-onchain.mjs
 *
 * Boolean coercion for dev-ui.mjs (stealth flags, etc.).
 * Local Anvil/forge bootstrap was removed from the dev server.
 */

/**
 * Coerces an environment variable string to a boolean.
 * Returns null when the value is absent or unrecognised.
 *
 * @param {unknown} value
 * @returns {boolean | null}
 */
export function coerceBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}
