/**
 * Shared label helpers used across app forms and config surfaces.
 */

export const ENV_KEY_ACRONYMS: Set<string> = new Set([
  "API",
  "URL",
  "ID",
  "SSH",
  "SSL",
  "HTTP",
  "HTTPS",
  "RPC",
  "NFT",
  "EVM",
  "TLS",
  "DNS",
  "IP",
  "JWT",
  "SDK",
  "LLM",
]);

export function autoLabel(key: string, pluginId: string): string {
  const prefixes = [
    `${pluginId.toUpperCase().replace(/-/g, "_")}_`,
    `${pluginId.toUpperCase().replace(/-/g, "")}_`,
  ];

  let remainder = key;
  for (const prefix of prefixes) {
    if (
      remainder.toUpperCase().startsWith(prefix) &&
      remainder.length > prefix.length
    ) {
      remainder = remainder.slice(prefix.length);
      break;
    }
  }

  return remainder
    .split("_")
    .filter(Boolean)
    .map((word) => {
      const upper = word.toUpperCase();
      if (ENV_KEY_ACRONYMS.has(upper)) {
        return upper;
      }
      return `${upper[0]}${word.slice(1).toLowerCase()}`;
    })
    .join(" ");
}
