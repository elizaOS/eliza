/** GHSA-w846-hghr-xmrc: browser navigation must not use file:// or other schemes. */
export function assertHttpHttpsUrl(url: string): URL {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Invalid protocol");
  }
  return parsed;
}
