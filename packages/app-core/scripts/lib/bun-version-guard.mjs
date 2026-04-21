const RECOMMENDED_BUN_MAJOR = 1;
const RECOMMENDED_BUN_MINOR = 3;

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
 * Returns a non-fatal advisory string if the given Bun version string is
 * canary or outside the recommended 1.3.x range. Returns null if OK or if
 * no version is provided.
 *
 * @param {string | undefined} [raw] - The Bun version string to check.
 *   Defaults to `globalThis.Bun?.version`.
 */
export function getBunVersionAdvisory(raw = globalThis.Bun?.version) {
  if (!raw) return null;
  const parsed = parseBunVersion(raw);
  if (!parsed) {
    return `Detected Bun ${raw}. Recommended: Bun ${RECOMMENDED_BUN_MAJOR}.${RECOMMENDED_BUN_MINOR}.x stable.`;
  }

  if (parsed.suffix.includes("canary")) {
    return `Detected Bun ${parsed.raw} (canary). Canary can break module interop; prefer Bun ${RECOMMENDED_BUN_MAJOR}.${RECOMMENDED_BUN_MINOR}.x stable.`;
  }

  if (
    parsed.major !== RECOMMENDED_BUN_MAJOR ||
    parsed.minor !== RECOMMENDED_BUN_MINOR
  ) {
    return `Detected Bun ${parsed.raw}. Recommended: Bun ${RECOMMENDED_BUN_MAJOR}.${RECOMMENDED_BUN_MINOR}.x stable.`;
  }

  return null;
}
