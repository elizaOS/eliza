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

function readEvaluator(root: string, observed?: string[]): string | undefined {
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
      const at = formatStamp(stat);
      if (observed) {
        const directory = path.dirname(file);
        observed.push(exe, manager, stamp([manager]), file, fs.realpathSync(file), at,
          formatStamp(fs.lstatSync(home, { bigint: true })), formatStamp(fs.lstatSync(directory, { bigint: true })), stamp([directory]));
      }
      digests.add(executableDigest(file, at));
    } catch { return undefined; }
  }
  return [...digests].join(" ");
}

export const evaluatorIdentity = (root: string) => readEvaluator(root);

export interface Evaluator { id: string; unchanged: () => boolean }

export function installedEvaluator(root: string): Evaluator | undefined {
  const observed: string[] = [];
  const id = readEvaluator(root, observed);
  return id ? { id, unchanged: () => {
    const current: string[] = [];
    return readEvaluator(root, current) === id && current.length === observed.length && current.every((value, i) => value === observed[i]);
  } } : undefined;
}

/**
 * The pinned Android build tools and platform the OS tests run against, as selected by
 * packages/os/test/support/android-tools.ts. The SDK is the first existing candidate among
 * ANDROID_HOME, ANDROID_SDK_ROOT and the usual home directories; the build tools and platform
 * below are the versions those tests pin.
 */
export const ANDROID_BUILD_TOOLS = "36.0.0";
export const ANDROID_PLATFORM = "android-36";

/** The executable named `name` that the PATH finds first, as the stock apksigner launcher finds java. */
function pathExecutable(name: string): string | undefined {
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    // A relative entry can choose a different program from a package's working directory.
    if (!path.isAbsolute(dir)) return undefined;
    for (const extension of extensions) {
      const file = path.join(dir, name + extension);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        if (fs.statSync(file).isFile()) return file;
      } catch {
        // Not an executable on this PATH entry; keep looking.
      }
    }
  }
  return undefined;
}

function jdkFor(executable: string): string | undefined {
  fs.accessSync(executable, fs.constants.X_OK);
  const bin = path.dirname(fs.realpathSync(executable));
  const home = path.dirname(bin);
  return path.basename(bin) === "bin" && fs.statSync(path.join(home, "release"), { throwIfNoEntry: false })?.isFile()
    ? home : undefined;
}

/** The files of one directory tree, in a stable order, with the label each is hashed under. */
function androidTreeFiles(root: string, label: string): { file: string; label: string }[] {
  const found: { file: string; label: string }[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, prefix: string) => {
    const real = fs.realpathSync(dir);
    if (seen.has(real)) return;
    seen.add(real);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const next = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stats = fs.statSync(file);
      if (stats.isDirectory()) walk(file, next);
      else if (stats.isFile()) found.push({ file, label: next });
    }
  };
  walk(root, label);
  return found.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/**
 * The Android toolchain the OS tests actually ran against, as one digest over the bytes of the
 * pinned build tools and platform of the selected SDK, the configured JDK, the JDK of the java the
 * stock apksigner launcher resolves through PATH, and the selected Java compiler and keytool. The digest
 * covers bytes, not directories, so installing the same toolchain at another path, or restoring a
 * replaced file's bytes, records the same toolchain again, while any changed file records a
 * different one. Nothing is returned when the SDK is absent or incomplete, so a run without the
 * toolchain never records a result a run with it could reuse.
 */
function readAndroidToolchain(): string | undefined {
  try {
    const sdk = [
      process.env.ANDROID_HOME,
      process.env.ANDROID_SDK_ROOT,
      path.join(os.homedir(), "Library", "Android", "sdk"),
      path.join(os.homedir(), "Android", "Sdk"),
    ].find((candidate) => candidate !== undefined && candidate !== "" && fs.existsSync(candidate));
    if (!sdk) return undefined;
    const tools = path.join(sdk, "build-tools", ANDROID_BUILD_TOOLS);
    const platform = path.join(sdk, "platforms", ANDROID_PLATFORM);
    const androidJar = path.join(platform, "android.jar");
    for (const file of [
      path.join(tools, "aapt"),
      path.join(tools, "aapt2"),
      path.join(tools, "apksigner"),
      path.join(tools, "zipalign"),
      androidJar,
    ]) {
      if (!fs.existsSync(file)) return undefined;
    }
    const javaHome = process.env.JAVA_HOME;
    const pathJava = pathExecutable("java");
    if (!pathJava) return undefined;
    const java = javaHome ? path.join(javaHome, "bin", "java") : pathJava;
    const javac = javaHome ? path.join(javaHome, "bin", "javac") : pathExecutable("javac");
    const keytool =
      javaHome && fs.existsSync(path.join(javaHome, "bin", "keytool"))
        ? path.join(javaHome, "bin", "keytool")
        : pathExecutable("keytool");
    if (!javac || !keytool) return undefined;
    const executables = { java, javac, keytool, "apksigner-java": pathJava };
    const jdks = new Map<string, string>();
    for (const [name, executable] of Object.entries(executables)) {
      const home = jdkFor(executable);
      if (!home) return undefined;
      if (!jdks.has(home)) jdks.set(home, name);
    }
    const files = [
      ...androidTreeFiles(tools, "build-tools"),
      ...androidTreeFiles(platform, "platform"),
      ...[...jdks].flatMap(([home, name]) => androidTreeFiles(home, `jdk/${name}`)),
    ];
    const digests: string[] = [];
    const seen = new Set<string>();
    const add = (label: string, file: string): boolean => {
      const real = fs.realpathSync(file);
      if (seen.has(real)) return true;
      seen.add(real);
      const digest = digestFile(file);
      if (!digest) return false;
      digests.push(`${label} ${digest}`);
      return true;
    };
    for (const { file, label } of files) {
      if (!add(label, file)) return undefined;
    }
    for (const [name, executable] of Object.entries(executables))
      digests.push(`${name} ${digestFile(executable)}`);
    return createHash("sha256").update(JSON.stringify(["android-toolchain-v2", ...digests])).digest("hex");
  } catch {
    return undefined;
  }
}

/** The digest of the Android toolchain the OS tests would run against, if that toolchain is complete. */
export function androidToolchainIdentity(): string | undefined {
  return readAndroidToolchain();
}
