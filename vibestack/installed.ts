import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findBin, stamp } from "./run.ts";

export function packageLocation(name: string, from: string, exists: (file: string) => boolean = fs.existsSync): string | undefined {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (path.basename(dir) !== "node_modules" && exists(path.join(candidate, "package.json"))) {
      exists(candidate);
      return fs.realpathSync(candidate);
    }
    if (dir === path.dirname(dir)) return undefined;
  }
}

export function packageRoots(exe: string, name: string, exists: (file: string) => boolean = fs.existsSync) {
  const loaded = packageLocation(name, import.meta.dirname, exists);
  return [packageLocation(name, path.resolve(exe, "../../.."), exists) ?? loaded, loaded] as const;
}

function installedFile<T>(read: (bytes: Buffer) => T) {
  const known = new Map<string, { at: string; value: T }>();
  return (file: string) => {
    const at = stamp([file]);
    const old = known.get(file);
    if (old?.at === at) return old.value;
    const value = read(fs.readFileSync(file));
    known.set(file, { at, value });
    return value;
  };
}

const evaluatorVersion = installedFile((bytes) => bytes.toString("utf8").match(/QUINT_EVALUATOR_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1]);
const evaluatorDigest = installedFile((bytes) => createHash("sha256").update(bytes).digest("hex"));

export function evaluatorIdentity(root: string): string | undefined {
  const exe = findBin("quint", root);
  if (!exe) return undefined;
  const roots = new Set(packageRoots(exe, "@informalsystems/quint"));
  const home = process.env.QUINT_HOME ?? path.join(os.homedir(), ".quint");
  if (!path.isAbsolute(home)) return undefined;
  const binary = process.platform === "win32" ? "quint_evaluator.exe" : "quint_evaluator";
  const digests = new Set<string>();
  for (const location of roots) {
    if (!location) return undefined;
    try {
      const manager = path.join(location, "dist/src/rust/binaryManager.js");
      const version = evaluatorVersion(manager);
      if (!version) return undefined;
      const file = path.join(home, `rust-evaluator-${version}`, binary);
      fs.accessSync(file, fs.constants.X_OK);
      if (!fs.statSync(file).isFile()) return undefined;
      digests.add(evaluatorDigest(file));
    } catch { return undefined; }
  }
  return [...digests].join(" ");
}
