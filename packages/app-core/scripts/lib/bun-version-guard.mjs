// The repo standardizes on the Bun 1.4 canary line (the Rust rewrite). Anything
// at or above 1.4 — canary or, once it lands, stable — is accepted.
const RECOMMENDED_BUN_MAJOR = 1;
const RECOMMENDED_BUN_MINOR = 4;

function parseBunVersion(rawVersion) {
  const trimmed = String(rawVersion ?? "").trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(trimmed);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    suffix: match[4] ?? "",
    raw: trimmed,
  };
}

/**
 * Returns a non-fatal advisory string if the given Bun version is older than
 * the recommended Bun 1.4 canary (Rust) line. Returns null if OK or if no
 * version is provided.
 *
 * @param {string | undefined} [raw] - The Bun version string to check.
 *   Defaults to `globalThis.Bun?.version`.
 */
export function getBunVersionAdvisory(raw = globalThis.Bun?.version) {
  if (!raw) return null;
  const parsed = parseBunVersion(raw);
  const advisory = `Recommended: Bun ${RECOMMENDED_BUN_MAJOR}.${RECOMMENDED_BUN_MINOR}.x (canary, Rust build). Run \`bun upgrade --canary\`.`;
  if (!parsed) {
    return `Detected Bun ${raw}. ${advisory}`;
  }

  if (
    parsed.major > RECOMMENDED_BUN_MAJOR ||
    (parsed.major === RECOMMENDED_BUN_MAJOR &&
      parsed.minor >= RECOMMENDED_BUN_MINOR)
  ) {
    return null;
  }

  return `Detected Bun ${parsed.raw}. ${advisory}`;
}
