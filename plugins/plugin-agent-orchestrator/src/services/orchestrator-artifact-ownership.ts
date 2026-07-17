/**
 * Fingerprinted ownership records for files the orchestrator writes into a
 * sub-agent workspace before or around a run. The residuals gate consumes these
 * records to distinguish unchanged orchestrator scaffolding from worker output:
 * a path name alone never proves ownership, only the bytes the orchestrator
 * wrote and can still verify.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export type OrchestratorOwnedArtifactSource =
  | "identity-scaffold"
  | "skills-manifest"
  | "completion-evidence";

export interface OrchestratorOwnedArtifact {
  path: string;
  sha256: string;
  byteLength: number;
  source: OrchestratorOwnedArtifactSource;
}

export function toWorkdirRelative(
  workdir: string,
  file: string,
): string | undefined {
  const trimmed = file.trim();
  if (!trimmed) return undefined;
  const absolute = isAbsolute(trimmed) ? trimmed : resolve(workdir, trimmed);
  const rel = relative(workdir, absolute).split("\\").join("/");
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    return undefined;
  }
  return rel;
}

function fingerprint(content: string | Buffer): {
  sha256: string;
  byteLength: number;
} {
  const bytes =
    typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  };
}

export function createOwnedArtifactRecord(
  workdir: string,
  file: string,
  content: string | Buffer,
  source: OrchestratorOwnedArtifactSource,
): OrchestratorOwnedArtifact | undefined {
  const path = toWorkdirRelative(workdir, file);
  if (!path) return undefined;
  return { path, source, ...fingerprint(content) };
}

export function ownedArtifactStillMatches(
  workdir: string,
  artifact: OrchestratorOwnedArtifact,
): boolean {
  const path = toWorkdirRelative(workdir, artifact.path);
  if (!path || path !== artifact.path) return false;
  try {
    const current = readFileSync(join(workdir, path));
    const currentFingerprint = fingerprint(current);
    return (
      currentFingerprint.sha256 === artifact.sha256 &&
      currentFingerprint.byteLength === artifact.byteLength
    );
  } catch {
    // error-policy:J3 an absent/unreadable owned artifact is explicitly not a
    // match, so the residuals gate reports the dirty line instead of fabricating
    // ownership.
    return false;
  }
}
