/** Validates the revision embedded in a running packaged renderer. */

export interface PackagedRendererStamp {
  buildId?: unknown;
  commit?: unknown;
}

export function assertCurrentPackagedRevision(
  stamp: PackagedRendererStamp | null | undefined,
  expectedRevision: string,
): { buildId: string; commit: string } {
  const buildId =
    typeof stamp?.buildId === "string" ? stamp.buildId.trim() : "";
  const commit = typeof stamp?.commit === "string" ? stamp.commit.trim() : "";
  if (
    buildId.length === 0 ||
    !/^[0-9a-f]{40}$/.test(commit) ||
    commit !== expectedRevision
  ) {
    throw new Error(
      `Running packaged renderer revision ${commit || "<missing>"} does not match checkout ${expectedRevision}.`,
    );
  }
  return { buildId, commit };
}
