/** Implements Electrobun desktop pglite paths ts behavior for app-core shell integration. */
import fs from "node:fs";
import path from "node:path";

export interface PglitePathOptions {
  appStateDir: string;
}

export interface PglitePathDescription {
  dataDir: string;
  insideAppState: boolean;
  insideAppBundle: boolean;
  memory: boolean;
  writableParent: boolean;
}

export function isMemoryPgliteDataDir(dataDir: string): boolean {
  return dataDir.trim() === "memory://";
}

export function resolveDefaultPgliteDataDir(
  options: PglitePathOptions,
): string {
  return path.join(options.appStateDir, "database", "pglite");
}

export function resolvePgliteDataDirPath(
  dataDir: string,
  cwd: string = process.cwd(),
): string {
  const trimmed = dataDir.trim();
  if (isMemoryPgliteDataDir(trimmed)) return trimmed;
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
}

function isInsidePath(childPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function parentWritable(targetPath: string): boolean {
  try {
    const parent = path.dirname(targetPath);
    fs.mkdirSync(parent, { recursive: true });
    fs.accessSync(parent, fs.constants.W_OK);
    return true;
  } catch {
    // error-policy:J4 parent dir not creatable/writable -> reported as not writable
    return false;
  }
}

export function ensurePgliteDataDir(dataDir: string): void {
  const resolved = resolvePgliteDataDirPath(dataDir);
  if (isMemoryPgliteDataDir(resolved)) return;
  fs.mkdirSync(resolved, { recursive: true });
  fs.accessSync(resolved, fs.constants.W_OK);
}

export function describePglitePath(
  dataDir: string,
  options: PglitePathOptions,
): PglitePathDescription {
  const resolved = resolvePgliteDataDirPath(dataDir);
  const memory = isMemoryPgliteDataDir(resolved);
  return {
    dataDir: resolved,
    insideAppState: memory
      ? false
      : isInsidePath(resolved, options.appStateDir),
    insideAppBundle: memory ? false : resolved.includes(".app/Contents"),
    memory,
    writableParent: memory ? true : parentWritable(resolved),
  };
}

export function assertSafePgliteResetTarget(dataDir: string): string {
  const resolved = resolvePgliteDataDirPath(dataDir);
  if (isMemoryPgliteDataDir(resolved)) {
    throw new Error("memory:// PGlite data cannot be backed up or reset.");
  }
  if (!path.isAbsolute(resolved)) {
    throw new Error("PGlite reset target must be absolute.");
  }
  const parsed = path.parse(resolved);
  if (resolved === parsed.root || resolved === path.dirname(resolved)) {
    throw new Error("PGlite reset target is too broad.");
  }
  const basename = path.basename(resolved);
  if (basename !== "pglite" && basename !== ".elizadb") {
    throw new Error(
      `PGlite reset target must end in pglite or .elizadb: ${resolved}`,
    );
  }
  if (resolved.includes(".app/Contents")) {
    throw new Error("PGlite reset target cannot be inside an app bundle.");
  }
  return resolved;
}
