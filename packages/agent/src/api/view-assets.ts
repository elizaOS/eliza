/** Installation-owned publication inventory for local view assets. */
import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import { isPathWithinRoot, resolveRealPath } from "./realpath-confinement.ts";
import type { ViewRegistryEntry } from "./view-registry-types.ts";

export type ViewAssetKind = "bundle" | "frame";
interface Asset {
  readonly hash: string;
  readonly size: number;
}
export interface ViewAssetRoot {
  readonly directory: string;
  readonly rootName: string;
  readonly files: ReadonlyMap<string, Asset>;
  readonly explicit: boolean;
}
const inventories = new WeakMap<
  ViewRegistryEntry,
  Partial<Record<ViewAssetKind, ViewAssetRoot>>
>();

export function validViewAssetPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/[\\?#]/u.test(value) &&
    Array.from(value).every(
      (char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127,
    ) &&
    value
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

/** Open nonblocking, then verify the descriptor before reading any bytes. */
async function readRegularFile(
  directory: string,
  file: string,
): Promise<Buffer> {
  const real = await resolveRealPath(path.resolve(directory, file));
  if (!real || !isPathWithinRoot(real, directory)) {
    throw new ElizaError(
      "View asset resolves outside its publication directory",
      { code: "VIEW_ASSET_CHANGED", context: { file } },
    );
  }
  const handle = await fs.open(
    real,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    if (!(await handle.stat()).isFile()) {
      throw new ElizaError("View asset is no longer a regular file", {
        code: "VIEW_ASSET_CHANGED",
        context: { file },
      });
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function captureViewAssetRoot(
  rootPath: string,
): Promise<ViewAssetRoot> {
  const directory = await fs.realpath(path.dirname(rootPath));
  const rootName = path.basename(rootPath);
  let files: string[] = [rootName];
  let explicit = false;
  try {
    const manifest: unknown = JSON.parse(
      (await readRegularFile(directory, `${rootName}.assets.json`)).toString(
        "utf8",
      ),
    );
    if (
      !manifest ||
      typeof manifest !== "object" ||
      !("version" in manifest) ||
      manifest.version !== 1 ||
      !("files" in manifest) ||
      !Array.isArray(manifest.files) ||
      !manifest.files.every(validViewAssetPath)
    ) {
      throw new ElizaError(
        "Expected a version 1 view asset manifest with relative file paths",
        { code: "VIEW_ASSET_MANIFEST_INVALID", context: { rootName } },
      );
    }
    files = [...new Set([rootName, ...manifest.files])];
    explicit = true;
  } catch (error) {
    // error-policy:J2 Invalid manifests retain their cause; absence publishes only the declared root.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ElizaError("Invalid view asset manifest", {
        code: "VIEW_ASSET_MANIFEST_INVALID",
        cause: error,
        context: { rootName },
      });
    }
  }
  const captured = new Map<string, Asset>();
  for (const file of files) {
    const bytes = await readRegularFile(directory, file);
    captured.set(file, {
      hash: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    });
  }
  return { directory, rootName, files: captured, explicit };
}

export function setViewAssets(
  entry: ViewRegistryEntry,
  roots: Partial<Record<ViewAssetKind, ViewAssetRoot>>,
): void {
  inventories.set(entry, roots);
}

export function bindViewAssets(
  source: ViewRegistryEntry,
  installed: ViewRegistryEntry,
): void {
  const inventory = inventories.get(source);
  if (inventory) inventories.set(installed, inventory);
}

export function getViewAssetRoot(
  entry: ViewRegistryEntry,
  kind: ViewAssetKind,
): ViewAssetRoot | undefined {
  return inventories.get(entry)?.[kind];
}

export async function readViewAsset(
  root: ViewAssetRoot,
  file: string,
): Promise<Buffer> {
  const asset = root.files.get(file);
  if (!asset)
    throw new ElizaError(
      root.explicit
        ? "Asset is not published by this installation"
        : "Declare sibling assets in a root-adjacent .assets.json manifest and reinstall the view",
      { code: "VIEW_ASSET_NOT_PUBLISHED" },
    );
  const bytes = await readRegularFile(root.directory, file);
  if (createHash("sha256").update(bytes).digest("hex") !== asset.hash)
    throw new ElizaError(
      "View asset changed; reinstall the view before loading it",
      { code: "VIEW_ASSET_CHANGED" },
    );
  return bytes;
}
