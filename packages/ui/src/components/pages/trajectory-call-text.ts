/**
 * Normalizes sparse provider call payloads for trajectory rendering and derives
 * truthful line metadata from the exact rendered text.
 */

export function formatTrajectoryCallPayload(value: unknown): string {
  if (value == null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function normalizeTrajectoryCallText(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (typeof candidate === "string" && candidate.length === 0) continue;
    return formatTrajectoryCallPayload(candidate);
  }
  return "";
}

export function countTrajectoryCallTextLines(...candidates: unknown[]): number {
  const text = normalizeTrajectoryCallText(...candidates);
  return text.length === 0 ? 0 : text.split(/\r?\n/).length;
}
