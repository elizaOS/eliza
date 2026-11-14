import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ReleaseFile {
  filename: string;
  sha256: string;
  sizeBytes: number;
}

export interface SignedReleaseDescription {
  subjectSha256: string;
  issuedAt: string;
  release: {
    releaseId: string;
    version: string;
    channel: "stable" | "beta" | "canary";
    operation: "os-install" | "lab-experiment";
    target: {
      id: string;
      codename: string;
      kind: "physical" | "virtual";
      architecture: "arm64" | "x86_64" | "riscv64";
    };
    files: ReleaseFile[];
    startingStates: Array<{ recovery: { archive: ReleaseFile } }>;
  };
}

export function signedInstallerPath(): string {
  for (const relative of [
    "../../../scripts/android/install-release.ts",
    "../scripts/android/install-release.ts",
  ]) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw new Error("Signed Android installer is unavailable.");
}

/** Authenticate using the packaged executor's policy, never downloaded keys. */
export async function describeSignedRelease(
  bytes: string,
): Promise<SignedReleaseDescription> {
  const directory = await mkdtemp(join(tmpdir(), "elizaos-release-discovery-"));
  try {
    const manifest = join(directory, "manifest.json");
    await writeFile(manifest, bytes, { mode: 0o600, flag: "wx" });
    const result = spawnSync(
      "node",
      [signedInstallerPath(), "--describe", "--manifest", manifest],
      {
        encoding: "utf8",
        timeout: 30_000,
        killSignal: "SIGKILL",
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        result.stderr.trim() || "Signed release discovery failed",
      );
    }
    return JSON.parse(result.stdout) as SignedReleaseDescription;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Preserve every install and recovery file; reject ambiguous filename reuse. */
export function signedReleaseFiles(
  description: SignedReleaseDescription,
): ReleaseFile[] {
  const files = new Map<string, ReleaseFile>();
  for (const file of [
    ...description.release.files,
    ...description.release.startingStates.map(
      (state) => state.recovery.archive,
    ),
  ]) {
    const previous = files.get(file.filename);
    if (
      previous &&
      (previous.sha256 !== file.sha256 || previous.sizeBytes !== file.sizeBytes)
    ) {
      throw new Error(`Conflicting signed file contracts for ${file.filename}`);
    }
    files.set(file.filename, file);
  }
  return [...files.values()];
}
