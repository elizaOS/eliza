/** Reports unsupported Bun runtimes without contradicting the repository pin. */
const MINIMUM_BUN_MAJOR = 1;
const MINIMUM_BUN_MINOR = 3;
const REPOSITORY_BUN_PIN = "1.3.14";

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
 * the supported Bun 1.3 line. Returns null if supported or if no version is
 * provided.
 *
 * @param {string | undefined} [raw] - The Bun version string to check.
 *   Defaults to `globalThis.Bun?.version`.
 */
export function getBunVersionAdvisory(raw = globalThis.Bun?.version) {
  if (!raw) return null;
  const parsed = parseBunVersion(raw);
  const advisory = `Supported: Bun ${MINIMUM_BUN_MAJOR}.${MINIMUM_BUN_MINOR}.x or newer (repository pin: ${REPOSITORY_BUN_PIN}). Use the repository-pinned version.`;
  if (!parsed) {
    return `Detected Bun ${raw}. ${advisory}`;
  }

  if (
    parsed.major > MINIMUM_BUN_MAJOR ||
    (parsed.major === MINIMUM_BUN_MAJOR && parsed.minor >= MINIMUM_BUN_MINOR)
  ) {
    return null;
  }

  return `Detected Bun ${parsed.raw}. ${advisory}`;
}
