import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findBin, formatStamp, stamp, writeWhole } from "./run.ts";

export class InstallationChanged extends Error {
  constructor() { super("a tool installation changed during this check; run the check again"); }
}

/**
 * What was said of installed files, remembered across processes while each is unchanged: the same device, inode, size,
 * and modification and change times, which a copy or an archive cannot set back. An unchanged toolchain is not read again.
 */
export const LASTING = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "vibestack", "toolchain.json");
const MAX_TOOLCHAIN_ENTRIES = 4096;
const programsPrefix = path.join(path.dirname(LASTING), "programs") + path.sep;
interface Known { files: string[]; stamp: string; value: string; at?: number }
type Said = Record<string, Known>;
const isKnown = (k: unknown): k is Known => typeof k === "object" && k !== null
  && "files" in k && Array.isArray(k.files) && k.files.every((f) => typeof f === "string")
  && "stamp" in k && typeof k.stamp === "string" && "value" in k && typeof k.value === "string"
  && (!("at" in k) || k.at === undefined || (typeof k.at === "number" && Number.isFinite(k.at)));
let said: Said | undefined;
const learned: Said = {};
const touched = new Set<string>();
let exitHooked = false;
let needsCompact = false;
const readSaid = (inspect = false): Said => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(LASTING, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const valid = Object.entries(parsed).filter(([, k]) => isKnown(k));
    if (inspect && (valid.length > MAX_TOOLCHAIN_ENTRIES || valid.some(([, k]) => k.files.length > 0 && k.files[0].startsWith(programsPrefix)))) {
      needsCompact = true;
    }
    return Object.fromEntries(valid);
  } catch {
    return {};
  }
};
const keepSaid = () => {
  if (!Object.keys(learned).length && !needsCompact) return true;
  try {
    const now = Date.now();
    const merged = Object.entries({ ...readSaid(), ...learned })
      .filter(([, k]) => !k.files.length || (!k.files[0].startsWith(programsPrefix) && fs.existsSync(k.files[0])))
      .map(([key, k]): [string, Known] => [key, touched.has(key) ? { ...k, at: now } : k]);
    const pinned = merged.filter(([key]) => touched.has(key));
    const others = merged.filter(([key]) => !touched.has(key)).sort(([, a], [, b]) => (b.at ?? 0) - (a.at ?? 0));
    const retained = [...pinned, ...others.slice(0, Math.max(0, MAX_TOOLCHAIN_ENTRIES - pinned.length))];
    writeWhole(LASTING, JSON.stringify(Object.fromEntries(retained)));
    needsCompact = false;
    return true;
  } catch {
    return false;
  }
};
const hookExit = () => { if (!exitHooked) { exitHooked = true; process.once("exit", keepSaid); } };
export function lasting(key: string, files: string[], now = stamp(files)) {
  if (!said) {
    said = readSaid(true);
    if (needsCompact) hookExit();
  }
  const known = said[key];
  const hit = known?.stamp === now;
  if (hit) {
    known.at = Date.now();
    touched.add(key);
  }
  return {
    value: hit ? known.value : undefined,
    keep: (value: string) => {
      hookExit();
      touched.add(key);
      said![key] = learned[key] = { files, stamp: now, value, at: Date.now() };
      return value;
    },
  };
}

function lastingFile(prefix: string, read: (bytes: Buffer) => string | undefined) {
  const known = new Map<string, { at: string; value: string | undefined }>();
  return (file: string, knownStamp?: string): string | undefined => {
    const at = knownStamp ?? stamp([file]);
    const old = known.get(file);
    if (old?.at === at) return old.value;
    const { value, keep } = lasting(`${prefix} ${file}`, [file], at);
    const resolved = value ?? read(fs.readFileSync(file));
    if (value === undefined && resolved !== undefined) keep(resolved);
    known.set(file, { at, value: resolved });
    return resolved;
  };
}

const digestFile = lastingFile("sha256", (bytes) => createHash("sha256").update(bytes).digest("hex"));

/** The executable's bytes, independent of the directory its installation lives in. */
export const executableDigest = (file: string, knownStamp?: string): string => digestFile(file, knownStamp)!;

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

const evaluatorVersion = lastingFile("quint-eval-ver", (bytes) => bytes.toString("utf8").match(/QUINT_EVALUATOR_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1]);

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
      const stat = fs.statSync(file, { bigint: true });
      if (!stat.isFile()) return undefined;
      digests.add(executableDigest(file, formatStamp(stat)));
    } catch { return undefined; }
  }
  return [...digests].join(" ");
}
