/**
 * Type declarations for `artifact-staleness.mjs` — generic source-vs-artifact
 * staleness used by the iOS MTP slice, iOS agent bundle, and desktop runtime
 * package reuse gates (issue #9309).
 */

export function maxMtimeUnder(
  dir: string,
  opts?: {
    exclude?: Set<string>;
    exts?: Set<string> | null;
    maxDepth?: number;
  },
): number;

export function fileMtime(filePath: string): number;

export interface ArtifactStaleness {
  stale: boolean;
  reason: string;
  artifactMtime: number;
  newestSourceMtime: number;
  newestSource: string | null;
}

export function artifactStaleness(
  artifactPath: string,
  opts?: {
    sourceDirs?: string[];
    sourceFiles?: string[];
    exts?: Set<string> | null;
  },
): ArtifactStaleness;
