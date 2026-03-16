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
    if (key.startsWith(prefix) && key.length > prefix.length) {
      remainder = key.slice(prefix.length);
      break;
    }
  }

  return remainder
    .split("_")
    .map((word) =>
      ENV_KEY_ACRONYMS.has(word)
        ? word
        : `${word[0]}${word.slice(1).toLowerCase()}`,
    )
    .join(" ");
}
