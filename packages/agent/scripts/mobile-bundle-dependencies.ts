/** Hash-bound npm inventory for mobile artifacts, independent of printed JS. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export interface MobileBundleDependencies {
  version: 1;
  bundleSha256: string;
  packages: {
    directory: string;
    name: string;
    version: string;
    packageJsonSha256: string;
  }[];
}

const PACKAGE_DIRECTORY =
  /^node_modules\/(?:\.bun\/[^/\s]+\/node_modules\/)?(?:@[^/\s]+\/)?[^/\s@][^/\s]*$/;
const PACKAGE_INPUT =
  /^(node_modules\/(?:\.bun\/[^/\s]+\/node_modules\/)?(?:@[^/\s]+\/)?[^/\s@][^/\s]*)\//;
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const posix = (value: string) => value.split(path.sep).join("/");
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function packageMetadata(repositoryRoot: string, directory: string) {
  if (
    !PACKAGE_DIRECTORY.test(directory) ||
    directory.split("/").some((part) => part === "." || part === "..") ||
    directory.includes("\\")
  )
    throw new Error("Mobile bundle dependency directory is not canonical.");
  const root = realpathSync(repositoryRoot);
  const actual = realpathSync(path.join(root, directory));
  const relative = path.relative(root, actual);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error("Mobile bundle dependency escapes its source directory.");
  let bytes: Uint8Array;
  let manifest: unknown;
  try {
    bytes = readFileSync(path.join(actual, "package.json"));
    manifest = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (cause) {
    throw new Error(
      `Mobile bundle dependency ${directory}/package.json is unreadable or corrupted.`,
      { cause },
    );
  }
  if (
    !record(manifest) ||
    typeof manifest.name !== "string" ||
    !manifest.name ||
    typeof manifest.version !== "string" ||
    !manifest.version
  )
    throw new Error(
      `Mobile bundle dependency ${directory}/package.json has no package identity.`,
    );
  return {
    directory,
    name: manifest.name,
    version: manifest.version,
    packageJsonSha256: sha256(bytes),
  };
}

/** Only inputs with emitted bytes contribute a shipped package. */
export function createMobileBundleDependencies({
  inputs,
  resolveDirectory,
  repositoryRoot,
  bundleBytes,
}: {
  inputs: Record<string, { bytesInOutput: number }>;
  resolveDirectory: string;
  repositoryRoot: string;
  bundleBytes: Uint8Array;
}): MobileBundleDependencies {
  const root = realpathSync(repositoryRoot);
  const directories = new Set<string>();
  for (const [input, metadata] of Object.entries(inputs)) {
    if (metadata.bytesInOutput <= 0 || !input.includes("node_modules/"))
      continue;
    // Retain the exact source path, including hoisted aliases. Resolving these
    // to a shared Bun-store path would change the emitted dependency inventory.
    const absolute = path.resolve(resolveDirectory, input);
    const actual = path.relative(root, realpathSync(absolute));
    if (
      actual === ".." ||
      actual.startsWith(`..${path.sep}`) ||
      path.isAbsolute(actual)
    )
      throw new Error("Mobile dependency input is outside the build source.");
    const relative = posix(path.relative(root, absolute));
    const directory = PACKAGE_INPUT.exec(relative)?.[1];
    if (!directory)
      throw new Error("Mobile dependency input is outside the build source.");
    directories.add(directory);
  }
  if (directories.size === 0)
    throw new Error("Mobile bundle dependency inventory is empty.");
  return {
    version: 1,
    bundleSha256: sha256(bundleBytes),
    packages: [...directories]
      .sort()
      .map((directory) => packageMetadata(repositoryRoot, directory)),
  };
}

/** Verify the emitted bytes and installed package metadata before notice lookup. */
export function readMobileBundleDependencies(
  value: unknown,
  bundleBytes: Uint8Array,
  repositoryRoot: string,
): MobileBundleDependencies["packages"] {
  if (
    !record(value) ||
    value.version !== 1 ||
    value.bundleSha256 !== sha256(bundleBytes) ||
    !Array.isArray(value.packages) ||
    value.packages.length === 0
  )
    throw new Error(
      "Mobile bundle dependency inventory is missing or mismatched.",
    );
  const seen = new Set<string>();
  return value.packages.map((entry) => {
    if (!record(entry) || typeof entry.directory !== "string")
      throw new Error("Mobile bundle dependency record is invalid.");
    if (seen.has(entry.directory))
      throw new Error(
        "Mobile bundle dependency inventory contains duplicates.",
      );
    seen.add(entry.directory);
    const actual = packageMetadata(repositoryRoot, entry.directory);
    if (
      actual.name !== entry.name ||
      actual.version !== entry.version ||
      actual.packageJsonSha256 !== entry.packageJsonSha256
    )
      throw new Error("Mobile bundle dependency package metadata changed.");
    return actual;
  });
}
