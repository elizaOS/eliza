/**
 * Bootstrap and workspace-sync filesystem operations.
 *
 * These helpers prepare a container's persistent volume before the
 * container starts and shuttle workspace files in/out over SSH. All
 * remote shell quoting goes through `shellQuote`; path normalisation
 * goes through `normalizeBootstrapPath` so user-supplied paths cannot
 * escape the volume root.
 */

import * as crypto from "crypto";
import * as path from "path";
import { shellQuote } from "../../docker-sandbox-utils";
import type { DockerSSHClient } from "../../docker-ssh";
import { MAX_BOOTSTRAP_BYTES, MAX_BOOTSTRAP_FILES } from "./constants";
import {
  type ContainerBootstrapFile,
  type ContainerBootstrapSource,
  HetznerClientError,
} from "./types";

export function normalizeBootstrapPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new HetznerClientError(
      "invalid_input",
      `Invalid bootstrap file path: ${JSON.stringify(value)}`,
    );
  }
  const normalized = path.posix.normalize(trimmed);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new HetznerClientError(
      "invalid_input",
      `Bootstrap file path escapes workspace: ${JSON.stringify(value)}`,
    );
  }
  return normalized;
}

export function decodeBootstrapFile(file: ContainerBootstrapFile): Buffer {
  const bytes =
    file.encoding === "base64"
      ? Buffer.from(file.contents, "base64")
      : Buffer.from(file.contents, "utf8");
  if (typeof file.size === "number" && file.size !== bytes.byteLength) {
    throw new HetznerClientError("invalid_input", `Bootstrap file size mismatch for ${file.path}`);
  }
  if (file.sha256) {
    const actual = crypto.createHash("sha256").update(bytes).digest("hex");
    if (actual !== file.sha256.toLowerCase()) {
      throw new HetznerClientError(
        "invalid_input",
        `Bootstrap file sha256 mismatch for ${file.path}`,
      );
    }
  }
  return bytes;
}

function normalizeBootstrapMode(mode: string | undefined): string | null {
  if (!mode) return null;
  const trimmed = mode.trim();
  if (/^[0-7]{3,4}$/.test(trimmed)) return trimmed;
  const match = /^100([0-7]{3})$/.exec(trimmed);
  return match?.[1] ?? null;
}

function bootstrapManifest(
  source: ContainerBootstrapSource,
  fileCount: number,
  totalBytes: number,
) {
  return {
    sourceKind: source.sourceKind ?? null,
    projectId: source.projectId ?? null,
    workspaceId: source.workspaceId ?? null,
    rootPath: source.rootPath ?? null,
    snapshotId: source.snapshotId ?? null,
    revision: source.revision ?? null,
    manifest: source.manifest ?? null,
    fileCount,
    totalBytes,
    bootstrappedAt: new Date().toISOString(),
  };
}

export async function hydrateBootstrapSource(
  ssh: DockerSSHClient,
  volumePath: string,
  source: ContainerBootstrapSource | undefined,
): Promise<{ fileCount: number; totalBytes: number } | null> {
  const files = source?.files ?? [];
  if (!source || files.length === 0) return null;
  if (files.length > MAX_BOOTSTRAP_FILES) {
    throw new HetznerClientError(
      "invalid_input",
      `Bootstrap source has too many files: ${files.length}/${MAX_BOOTSTRAP_FILES}`,
    );
  }

  const decoded = files.map((file) => ({
    file,
    relativePath: normalizeBootstrapPath(file.path),
    bytes: decodeBootstrapFile(file),
  }));
  const totalBytes = decoded.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (totalBytes > MAX_BOOTSTRAP_BYTES) {
    throw new HetznerClientError(
      "invalid_input",
      `Bootstrap source is too large: ${totalBytes}/${MAX_BOOTSTRAP_BYTES} bytes`,
    );
  }

  await ssh.exec(
    `mkdir -p ${shellQuote(volumePath)} && find ${shellQuote(volumePath)} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`,
    60_000,
  );

  await writeDecodedWorkspaceFiles(ssh, volumePath, decoded);

  const manifestPath = path.posix.join(volumePath, ".eliza-coding", "source.json");
  await ssh.exec(`mkdir -p ${shellQuote(path.posix.dirname(manifestPath))}`, 30_000);
  await ssh.execStdin(
    `cat > ${shellQuote(manifestPath)}`,
    JSON.stringify(bootstrapManifest(source, decoded.length, totalBytes), null, 2),
    30_000,
  );

  return { fileCount: decoded.length, totalBytes };
}

export async function writeDecodedWorkspaceFiles(
  ssh: DockerSSHClient,
  volumePath: string,
  decoded: Array<{ file: ContainerBootstrapFile; relativePath: string; bytes: Buffer }>,
): Promise<void> {
  for (const item of decoded) {
    const target = path.posix.join(volumePath, item.relativePath);
    await ssh.exec(`mkdir -p ${shellQuote(path.posix.dirname(target))}`, 30_000);
    await ssh.execStdin(`cat > ${shellQuote(target)}`, item.bytes, 60_000);
    const mode = normalizeBootstrapMode(item.file.mode);
    if (mode) await ssh.exec(`chmod ${mode} ${shellQuote(target)}`, 30_000);
  }
}

export function decodeWorkspaceFiles(files: ContainerBootstrapFile[]): Array<{
  file: ContainerBootstrapFile;
  relativePath: string;
  bytes: Buffer;
}> {
  if (files.length > MAX_BOOTSTRAP_FILES) {
    throw new HetznerClientError(
      "invalid_input",
      `Workspace sync has too many files: ${files.length}/${MAX_BOOTSTRAP_FILES}`,
    );
  }
  const decoded = files.map((file) => ({
    file,
    relativePath: normalizeBootstrapPath(file.path),
    bytes: decodeBootstrapFile(file),
  }));
  const totalBytes = decoded.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (totalBytes > MAX_BOOTSTRAP_BYTES) {
    throw new HetznerClientError(
      "invalid_input",
      `Workspace sync is too large: ${totalBytes}/${MAX_BOOTSTRAP_BYTES} bytes`,
    );
  }
  return decoded;
}

export async function deleteWorkspaceFiles(
  ssh: DockerSSHClient,
  volumePath: string,
  files: Array<{ path: string; sha256?: string }>,
): Promise<void> {
  for (const file of files) {
    const target = path.posix.join(volumePath, normalizeBootstrapPath(file.path));
    await ssh.exec(`rm -f -- ${shellQuote(target)}`, 30_000);
  }
}

function parseWorkspaceExport(output: string): ContainerBootstrapFile[] {
  const files: ContainerBootstrapFile[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [pathBase64, sizeRaw, sha256, contents] = line.split("\t");
    if (!pathBase64 || !sizeRaw || !sha256 || contents === undefined) {
      throw new HetznerClientError("container_create_failed", "Malformed workspace export output");
    }
    const relativePath = Buffer.from(pathBase64, "base64").toString("utf8");
    normalizeBootstrapPath(relativePath);
    const size = Number(sizeRaw);
    files.push({
      path: relativePath,
      contents,
      encoding: "base64",
      ...(Number.isFinite(size) ? { size } : {}),
      sha256,
    });
  }
  if (files.length > MAX_BOOTSTRAP_FILES) {
    throw new HetznerClientError(
      "invalid_input",
      `Workspace export has too many files: ${files.length}/${MAX_BOOTSTRAP_FILES}`,
    );
  }
  return files;
}

export async function exportWorkspaceFiles(
  ssh: DockerSSHClient,
  volumePath: string,
): Promise<ContainerBootstrapFile[]> {
  const script = `
set -e
cd ${shellQuote(volumePath)}
find . -type f ! -path './.eliza-coding/*' -size -10485760c -print | sort | while IFS= read -r f; do
  rel=\${f#./}
  path_b64=$(printf '%s' "$rel" | base64 | tr -d '\\n')
  size=$(wc -c < "$f" | tr -d '[:space:]')
  sha=$(sha256sum "$f" | awk '{print $1}')
  body=$(base64 "$f" | tr -d '\\n')
  printf '%s\\t%s\\t%s\\t%s\\n' "$path_b64" "$size" "$sha" "$body"
done
`;
  return parseWorkspaceExport(await ssh.exec(script, 120_000));
}
