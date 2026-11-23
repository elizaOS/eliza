import { AsyncLocalStorage } from "node:async_hooks";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { sha, tokenize, writeWhole } from "./util.ts";
import { evaluatorIdentity, packageLocation, packageRoots } from "./installed.ts";
import { NEEDS_DAFNY, findBin, exec, onPath, stamp } from "./run.ts";

/** Load an operator's publishing credential only for the exact cache endpoint it belongs to. */
export function cacheCredentials(env: NodeJS.ProcessEnv, args: string[], declared: string | undefined, credentials: { apiUrl: string; writeToken: string }): NodeJS.ProcessEnv {
  const options = args.slice(0, args.includes("--") ? args.indexOf("--") : args.length);
  const supplied = (name: string) => options.some((arg) => arg === name || arg.startsWith(`${name}=`));
  let endpoint = env.TURBO_API ?? declared;
  for (const [index, arg] of options.entries()) {
    if (arg === "--api") endpoint = options[index + 1];
    else if (arg.startsWith("--api=")) endpoint = arg.slice("--api=".length);
  }
  return { ...env, ...env.TURBO_TOKEN === undefined && !supplied("--token") && endpoint === credentials.apiUrl
    ? { TURBO_API: credentials.apiUrl, TURBO_TOKEN: credentials.writeToken } : {} };
}

const packageVersion = (dep: string) => {
  for (let dir = import.meta.dirname; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const file = path.join(dir, "node_modules", dep, "package.json");
    if (fs.existsSync(file)) return `${dep}@${JSON.parse(fs.readFileSync(file, "utf8")).version}`;
  }
  return dep;
};

/**
 * What was said of installed files, remembered across processes while each is unchanged: the same device, inode, size,
 * and modification and change times, which a copy or an archive cannot set back. An unchanged toolchain is not read again.
 */
const LASTING = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "vibestack", "toolchain.json");
interface Known { files: string[]; stamp: string; value: string }
type Said = Record<string, Known>;
const isKnown = (k: unknown): k is Known => typeof k === "object" && k !== null && "files" in k && Array.isArray(k.files) && k.files.every((f) => typeof f === "string")
  && "stamp" in k && typeof k.stamp === "string" && "value" in k && typeof k.value === "string";
const readSaid = (): Said => {
  try {
    const said: unknown = JSON.parse(fs.readFileSync(LASTING, "utf8"));
    return typeof said === "object" && said !== null ? Object.fromEntries(Object.entries(said).filter(([, k]) => isKnown(k))) : {};
  } catch {
    return {};
  }
};
let said: Said | undefined;
const learned: Said = {};
const keepSaid = () => {
  try {
    writeWhole(LASTING, JSON.stringify(Object.fromEntries(Object.entries({ ...readSaid(), ...learned }).filter(([, k]) => k.files.every((f) => fs.existsSync(f))))));
    return true;
  } catch {
    return false;
  }
};
function lasting(key: string, files: string[], now = stamp(files)) {
  const known = (said ??= readSaid())[key];
  return {
    value: known?.stamp === now ? known.value : undefined,
    keep: (value: string) => {
      if (!Object.keys(learned).length) process.once("exit", keepSaid);
      (said ??= readSaid())[key] = learned[key] = { files, stamp: now, value };
      return value;
    },
  };
}

/** The executable's bytes, independent of the directory its installation lives in. */
export function executableDigest(file: string): string {
  const { value, keep } = lasting(`sha256 ${file}`, [file]);
  return value ?? keep(createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
}

const treeFiles = (directory: string) => fs.readdirSync(directory, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() || (entry.isSymbolicLink() && fs.statSync(path.join(entry.parentPath, entry.name)).isFile()))
  .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
  .sort();
/** Runtime files are keyed by relative name and bytes, never their installation directory. */
const treeDigest = (directory: string) => sha(...treeFiles(directory).map((file) => `${file}\0${executableDigest(path.join(directory, file))}`));

/** Where the verifier runs from: its launcher and the runtime launchers it starts, its managed assemblies, and any separately installed .NET host. */
function dafnyInstallation() {
  const launcher = onPath("dafny");
  if (!launcher) throw new Error("Dafny is not on PATH; the task cache needs its toolchain fingerprint");
  const real = fs.realpathSync(launcher);
  const assemblies = [path.dirname(real), path.resolve(path.dirname(real), "../libexec")]
    .find((dir) => fs.existsSync(path.join(dir, "Dafny.dll")));
  if (!assemblies) throw new Error("Dafny.dll is not beside Dafny or in ../libexec; the task cache cannot fingerprint this installation");
  const launchers = [real];
  for (;;) {
    const bytes = fs.readFileSync(launchers[launchers.length - 1]);
    const next = bytes.subarray(0, 2).toString() === "#!" ? bytes.toString().match(/\bexec\s+"([^"\n]*[\\/]dotnet(?:\.exe)?)"/)?.[1] : undefined;
    if (!next) break;
    launchers.push(fs.realpathSync(next));
    fs.accessSync(launchers[launchers.length - 1], fs.constants.X_OK);
    if (launchers.length > 5) throw new Error("Dafny's runtime launcher chain does not terminate");
  }
  const runtime = ["host", "shared"].map((dir) => path.join(path.dirname(launchers[launchers.length - 1]), dir)).filter((dir) => fs.existsSync(dir));
  if (!runtime.length && !fs.existsSync(path.join(assemblies, "System.Private.CoreLib.dll")))
    throw new Error("Dafny's external .NET runtime cannot be fingerprinted; use a self-contained release or an explicit dotnet launcher");
  return { launchers, assemblies, runtime };
}
const dafnyFiles = () => {
  try {
    const { launchers, assemblies, runtime } = dafnyInstallation();
    return [...launchers, ...[assemblies, ...runtime].flatMap((dir) => treeFiles(dir).map((file) => path.join(dir, file)))];
  } catch {
    return undefined;
  }
};

const dafnySaid = (version: string | undefined, stopped?: string, out = "") => {
  const problem = !version ? `Dafny could not be run (${out.trim().split("\n")[0] || "it printed no version"})`
    : !version.startsWith("4.11.") ? `this is Dafny ${version}, and LemmaScript targets Dafny 4.11.x` : undefined;
  return { version, problem: stopped ?? (problem && `${problem}: ${NEEDS_DAFNY}`) };
};
/**
 * Dafny's files and their stamps, as installed now: read once for each check (`steady`), and on
 * every call outside one.
 */
type Check = {
  installation?: { files?: string[]; at: string };
  programs: Map<string, Program | undefined>;
  evaluators: Map<string, string>;
  pending: Map<string, Buffer>;
  verify: Set<Program>;
  bytes: number;
  lastPublished: number;
  changed?: boolean;
  closed?: boolean;
  certified?: boolean;
};
const checking = new AsyncLocalStorage<Check>();

const MAX_PENDING_ENTRIES = 16;
const MAX_PENDING_BYTES = 8 * 1024 ** 2;
const PUBLISH_INTERVAL_MS = 1_000;

function includePrograms(check: Check) {
  for (const program of check.programs.values()) if (program?.id) check.verify.add(program);
}

export class InstallationChanged extends Error {
  constructor() { super("a tool installation changed during this check; run the check again"); }
}

function publishChecked(complete = false) {
  const check = checking.getStore();
  if (!check) return;
  if (complete) includePrograms(check);
  const replaced = [...check.verify].some((program) => !program.unchanged());
  if (replaced || check.changed) {
    check.changed = true;
    check.pending.clear();
    check.verify.clear();
    if (replaced) throw new InstallationChanged();
    return;
  }
  if (!check.pending.size) return;
  for (const [file, bytes] of check.pending) writeWhole(file, bytes);
  check.pending.clear();
  check.verify.clear();
  check.bytes = 0;
  check.lastPublished = performance.now();
}

export function certifyInstallation() {
  const check = checking.getStore();
  if (!check) return;
  publishChecked(true);
  if (check.changed) throw new InstallationChanged();
  check.certified = true;
}

function installation() {
  const now = () => {
    const files = dafnyFiles();
    if (!files) return { at: "" };
    try {
      return { files, at: files.map((file) => `${file}=${stamp([file])}`).join("\0") };
    } catch (e) {
      return { files, at: (e as Error).message };
    }
  };
  const scope = checking.getStore();
  return scope ? (scope.installation ??= now()) : now();
}
/** Run a check, which reads Dafny's installation once: a reinstall during it is seen by the next check, and by `verifiedNow`. */
export const steady = <T>(run: () => Promise<T>) => {
  const check: Check = { programs: new Map(), evaluators: new Map(), pending: new Map(), verify: new Set(), bytes: 0, lastPublished: -Infinity };
  return checking.run(check, async () => {
    try {
      const result = await run();
      if (!check.certified) publishChecked(true);
      return result;
    } finally {
      check.closed = true;
      check.pending.clear();
      check.verify.clear();
    }
  });
};

function perCheck<T>(read: () => Promise<T>): () => Promise<T> {
  const known = new WeakMap<Check, Promise<T>>();
  return () => {
    const scope = checking.getStore();
    if (!scope) return read();
    let result = known.get(scope);
    if (!result) known.set(scope, result = read().catch((e) => { known.delete(scope); throw e; }));
    return result;
  };
}

const TOOL_PACKAGES = { quint: "@informalsystems/quint", lsc: "lemmascript" } as const;
const packageName = (name: string) => /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name);
const NODE_FLAGS = ["NODE_OPTIONS", "NODE_PRESERVE_SYMLINKS", "NODE_PRESERVE_SYMLINKS_MAIN"] as const;
const nodeFlags = () => JSON.stringify(NODE_FLAGS.map((name) => process.env[name] ?? ""));
type Isolated = { entry: string; script: string };
type Program = { exe: string; unchanged: () => boolean } & ({ id: string; isolated: Isolated } | { id: undefined; isolated?: never });
const latest = new Map<keyof typeof TOOL_PACKAGES, Program>();

function virtualStore(dir: string): string | undefined {
  for (let at = dir; at !== path.dirname(at); at = path.dirname(at)) if (path.basename(at) === ".pnpm") return at;
  return undefined;
}

function pnpmSearchPaths(from: string, store: string): string[] {
  const paths: string[] = [];
  for (let dir = from; dir.startsWith(store + path.sep) || dir === store; dir = path.dirname(dir)) {
    if (path.basename(dir) !== "node_modules") paths.push(path.join(dir, "node_modules"));
  }
  return paths;
}

function shimNode(exe: string, text: string, observe: (file: string) => boolean): string | undefined {
  const windows = process.platform === "win32";
  const guard = windows ? '@IF EXIST "%~dp0\\node.exe" (' : 'if [ -x "$basedir/node" ]; then';
  const adjacentCall = windows ? /^  "%~dp0\\node\.exe" /m : /^  exec "\$basedir\/node" /m;
  const pathCall = windows ? /^  node /m : /^  exec node /m;
  if (!text.split(/\r?\n/).includes(guard) || !adjacentCall.test(text) || !pathCall.test(text) || /^ *(?:export |@SET "?)?PATH=/im.test(text)) return undefined;
  const executable = (file: string) => {
    if (!observe(file)) return false;
    if (windows) return true;
    try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
  };
  const adjacent = path.join(path.dirname(exe), windows ? "node.exe" : "node");
  let chosen = executable(adjacent) ? adjacent : undefined;
  if (!chosen) {
    // cmd.exe also searches the spawned working directory and PATHEXT.
    if (windows) return undefined;
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!path.isAbsolute(dir)) return undefined;
      const candidate = path.join(dir, "node");
      if (executable(candidate)) { chosen = candidate; break; }
    }
  }
  if (!chosen) return undefined;
  const resolved = fs.realpathSync(chosen);
  return resolved === fs.realpathSync(process.execPath) && observe(resolved) ? executableDigest(resolved) : undefined;
}

const PNPM_SHIM = [
  "#!/bin/sh",
  "basedir=$(dirname \"$(echo \"$0\" | sed -e 's,\\\\,/,g')\")",
  "",
  "case `uname` in",
  "    *CYGWIN*|*MINGW*|*MSYS*)",
  "        if command -v cygpath > /dev/null 2>&1; then",
  "            basedir=`cygpath -w \"$basedir\"`",
  "        fi",
  "    ;;",
  "esac",
  "",
  "if [ -z \"$NODE_PATH\" ]; then",
  "  export NODE_PATH=\"<paths>\"",
  "else",
  "  export NODE_PATH=\"<paths>\"",
  "fi",
  "if [ -x \"$basedir/node\" ]; then",
  "  exec \"$basedir/node\"  \"$basedir/<entry>\" \"$@\"",
  "else",
  "  exec node  \"$basedir/<entry>\" \"$@\"",
  "fi",
].join("\n") + "\n";

function launcherInputs(exe: string, packageDir: string, exists: (file: string) => boolean): { digest: string; entry: string } | undefined {
  const launcher = fs.realpathSync(exe);
  if (path.basename(path.dirname(launcher)) !== ".bin" || NODE_FLAGS.some((name) => process.env[name])) return undefined;
  const bytes = fs.readFileSync(launcher);
  if (!isUtf8(bytes)) return undefined;
  const store = virtualStore(packageDir);
  const text = bytes.toString("utf8").replaceAll("\r\n", "\n");
  if (!store) return undefined;
  const node = shimNode(exe, text, exists);
  if (node === undefined) return undefined;
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const name = path.basename(exe).replace(/\.cmd$/i, "");
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[name];
  if (typeof bin !== "string") return undefined;
  const entry = path.resolve(packageDir, bin);
  const relativeEntry = path.relative(packageDir, entry);
  if (path.isAbsolute(relativeEntry) || relativeEntry.split(path.sep).includes("..") || !exists(entry) || !fs.statSync(entry).isFile()) return undefined;
  const resolvedEntry = path.relative(packageDir, fs.realpathSync(entry));
  if (path.isAbsolute(resolvedEntry) || resolvedEntry.split(path.sep).includes("..")) return undefined;
  const normalized: string[] = [];
  for (const line of text.split("\n")) {
    if (/^  export NODE_PATH="[^"\r]*"$/.test(line)) normalized.push('  export NODE_PATH="<paths>"');
    else {
      const call = /^(  exec (?:"\$basedir\/node"|node)  "\$basedir\/)([^"$`\r\n]+)(" "\$@")$/.exec(line);
      if (!call) normalized.push(line);
      else {
        const called = path.resolve(path.dirname(exe), call[2]);
        if (!exists(called) || fs.realpathSync(called) !== fs.realpathSync(entry)) return undefined;
        normalized.push(`${call[1]}<entry>${call[3]}`);
      }
    }
  }
  if (normalized.join("\n") !== PNPM_SHIM) return undefined;
  const known = new Set(pnpmSearchPaths(bin ? path.dirname(path.resolve(packageDir, bin)) : packageDir, store));
  const lines = [node, path.relative(packageDir, entry)];
  for (const [index, line] of text.split("\n").entries()) {
    const assignment = /^( *export NODE_PATH="| *@SET "NODE_PATH=)([^"\r]*)("\r?)$/.exec(line);
    if (!assignment) {
      if (/\bNODE_PATH\s*=/.test(line)) return undefined;
      lines.push(JSON.stringify(normalized[index]));
      continue;
    }
    const [, before, paths, after] = assignment;
    const relative: (string | string[])[] = [];
    for (const entry of paths.split(before.includes("export") ? ":" : ";")) {
      if (entry === "$NODE_PATH" || entry === "%NODE_PATH%") relative.push(entry);
      else if (known.has(entry) && (path.dirname(entry) === packageDir || !entry.startsWith(packageDir + path.sep) || !exists(entry))) {
        relative.push([path.relative(store, entry)]);
      }
      else return undefined;
    }
    lines.push(JSON.stringify([before, relative, after]));
  }
  return { digest: sha(...lines), entry };
}

type Stamps = Iterable<readonly [string, string]>;
const fileStamp = (file: string, follow = true) => {
  const stat = (follow ? fs.statSync : fs.lstatSync)(file, { bigint: true, throwIfNoEntry: false });
  return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : "";
};
const sameFiles = (files: Stamps, links: Stamps) => {
  for (const [file, stamp] of files) if (fileStamp(file) !== stamp) return false;
  for (const [file, stamp] of links) if (fileStamp(file, false) !== stamp) return false;
  return true;
};
const isStamps = (value: unknown): value is [string, string][] => Array.isArray(value) && value.every((entry) =>
  Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string");

function readProgram(index: string, key: string): { id: string; isolated: Isolated; unchanged: () => boolean } | undefined {
  try {
    const data: unknown = JSON.parse(zstdDecompressSync(fs.readFileSync(index)).toString("utf8"));
    if (!Array.isArray(data)) return undefined;
    const [saved, id, files, links, isolated] = data;
    if (saved !== key || typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id) || !isStamps(files) || !files.length || !isStamps(links)) return undefined;
    if (typeof isolated !== "object" || !isolated || typeof isolated.entry !== "string" || typeof isolated.script !== "string"
      || ![isolated.entry, isolated.script].every((file) => file.startsWith(path.join(path.dirname(LASTING), "programs") + path.sep) && files.some(([observed]) => observed === file))) return undefined;
    const unchanged = () => sameFiles(files, links);
    if (unchanged()) return { id, isolated: { entry: isolated.entry, script: isolated.script }, unchanged };
  } catch {
    return undefined;
  }
}

function packageGraph(exe: string, name: string) {
  const observations = new Map<string, string>();
  const links = new Map<string, string>();
  const observed = (file: string) => {
    if (!observations.has(file)) observations.set(file, fileStamp(file));
    return observations.get(file) !== "";
  };
  const contents = (root: string, isolated = false) => {
    const files: { name: string; file?: string; target?: string }[] = [];
    const signature = createHash("sha256");
    const record = (file: string) => {
      const exists = observed(file);
      signature.update(JSON.stringify([file, observations.get(file), links.get(file)]));
      return exists;
    };
    const walk = (dir: string, ancestors: Set<string>) => {
      record(dir);
      if (isolated && dir !== root && observed(path.join(dir, "node_modules"))) throw new Error("an isolated package has nested ambient modules");
      const real = fs.realpathSync(dir);
      if (ancestors.has(real)) return;
      const parents = new Set(ancestors).add(real);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const file = path.join(dir, entry.name);
        const name = path.relative(root, file).split(path.sep).join("/");
        if (entry.isSymbolicLink()) links.set(file, fileStamp(file, false));
        const target = entry.isSymbolicLink() ? fs.readlinkSync(file) : undefined;
        if (!record(file)) files.push({ name, target });
        else if (entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(file).isDirectory())) {
          files.push({ name: name + "/", target });
          walk(file, parents);
        } else files.push({ name, file, target });
      }
    };
    walk(root, new Set());
    const { value, keep } = lasting(`package contents ${root}`, [root], signature.digest("hex"));
    return value ?? keep(sha(...files.map(({ name, file, target }) =>
      JSON.stringify([name, target, file && createHash("sha256").update(fs.readFileSync(file)).digest("hex")])).sort()));
  };
  const observeLocation = (file: string) => {
    const present = observed(file);
    if (present && path.basename(file) !== "package.json" && fs.lstatSync(file).isSymbolicLink()) links.set(file, fileStamp(file, false));
    return present;
  };
  const seen = new Map<string, number>();
  const graph: { dir: string; name: string; version: string; dependencies: [string, number | null][] }[] = [];
  let complete = true;
  const visit = (dir: string): number => {
    const previous = seen.get(dir);
    if (previous !== undefined) return previous;
    const file = path.join(dir, "package.json");
    observed(file);
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof pkg.name !== "string" || !packageName(pkg.name) || typeof pkg.version !== "string") throw new Error(`no ${pkg.name ?? name} with a version is installed at ${dir}`);
    const index = graph.length;
    seen.set(dir, index);
    const dependencies: [string, number | null][] = [];
    graph.push({ name: pkg.name, version: `${pkg.name}@${pkg.version}`, dir, dependencies });
    for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }).sort()) {
      if (!packageName(dependency)) throw new Error(`invalid package dependency ${dependency}`);
      const at = packageLocation(dependency, dir, observeLocation);
      if (!at && dependency in (pkg.dependencies ?? {})) complete = false;
      dependencies.push([dependency, at ? visit(at) : null]);
    }
    return index;
  };
  observed(exe);
  if (fs.lstatSync(exe).isSymbolicLink()) links.set(exe, fileStamp(exe, false));
  observed(path.dirname(exe));
  const [main, loaded] = packageRoots(exe, name, observeLocation);
  if (!main) throw new Error(`no ${name} with a version is installed beside ${exe} or these tools; run pnpm install`);
  const roots = [visit(main), loaded && visit(loaded)];
  const isolate = (id: string, entry: string, expected: readonly string[]): Isolated => {
    if (!complete) throw new Error("a declared dependency needs ambient resolution");
    const script = path.join(import.meta.dirname, `simulator${path.extname(import.meta.filename)}`);
    observed(script);
    const scriptId = executableDigest(script);
    const directory = path.join(path.dirname(LASTING), "programs", "1");
    const view = path.join(directory, `${id}-${scriptId.slice(0, 12)}`);
    const dependencies = graph.map((node, index): [string, number | null][] => node.dependencies.some(([name]) => name === node.name) ? node.dependencies : [...node.dependencies, [node.name, index]]);
    fs.mkdirSync(directory, { recursive: true });
    if (!fs.existsSync(view)) {
      const staged = fs.mkdtempSync(path.join(directory, ".building-"));
      try {
        for (const [index, { dir }] of graph.entries()) {
          const target = path.join(staged, "packages", String(index));
          fs.cpSync(dir, target, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE,
            filter: (file) => {
              if (["node_modules", ".git"].includes(path.basename(file))) return false;
              if (fs.lstatSync(file).isSymbolicLink()) {
                const link = fs.readlinkSync(file);
                if (path.isAbsolute(link) || path.relative(dir, fs.realpathSync(file)).startsWith("..")) throw new Error("a package link escapes its isolated installation");
              }
              return true;
            } });
          const modules = path.join(target, "node_modules");
          fs.mkdirSync(modules);
          for (const [name, dependency] of dependencies[index]) if (dependency !== null) {
            const link = path.join(modules, name);
            fs.mkdirSync(path.dirname(link), { recursive: true });
            fs.symlinkSync(path.relative(path.dirname(link), path.join(staged, "packages", String(dependency))), link, "dir");
          }
        }
        fs.writeFileSync(path.join(staged, "package.json"), '{"type":"module"}');
        const loaded = roots[1] ?? roots[0];
        const link = path.join(staged, "node_modules", name);
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(path.relative(path.dirname(link), path.join(staged, "packages", String(loaded))), link, "dir");
        fs.copyFileSync(script, path.join(staged, path.basename(script)));
        if (!sameFiles(observations, links)) throw new InstallationChanged();
        try { fs.renameSync(staged, view); } catch (error) { if (!fs.existsSync(view)) throw error; }
      } finally { fs.rmSync(staged, { recursive: true, force: true }); }
    }
    const modulesMatch = (directory: string, names: string[]) => {
      observeLocation(directory);
      const first = [...new Set(names.map((name) => name.split("/")[0]))].sort();
      if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(first)) throw new Error("an isolated installation has undeclared modules");
      for (const scope of first.filter((name) => name.startsWith("@"))) {
        const scoped = path.join(directory, scope);
        observeLocation(scoped);
        const expected = names.filter((name) => name.startsWith(scope + "/")).map((name) => name.slice(scope.length + 1)).sort();
        if (JSON.stringify(fs.readdirSync(scoped).sort()) !== JSON.stringify(expected)) throw new Error("an isolated installation has undeclared scoped modules");
      }
    };
    for (const [index] of graph.entries()) {
      const target = path.join(view, "packages", String(index));
      if (contents(target, true) !== expected[index]) throw new Error("an isolated package differs from its source");
      const modules = path.join(target, "node_modules");
      modulesMatch(modules, dependencies[index].filter(([, dependency]) => dependency !== null).map(([name]) => name));
      for (const [name, dependency] of dependencies[index]) if (dependency !== null) {
        const link = path.join(modules, name);
        if (!observeLocation(link) || fs.realpathSync(link) !== path.join(view, "packages", String(dependency))) throw new Error("an isolated dependency differs from its source");
      }
    }
    const privateScript = path.join(view, path.basename(script));
    const privateEntry = path.join(view, "packages", String(roots[0]), path.relative(main, entry));
    if (!observeLocation(privateEntry) || path.relative(path.join(view, "packages", String(roots[0])), fs.realpathSync(privateEntry)).split(path.sep).includes("..")
      || executableDigest(privateEntry) !== executableDigest(entry)) throw new Error("an isolated entry differs from its source");
    for (const file of [privateScript, path.join(view, "package.json"), path.join(view, "node_modules", name)]) observeLocation(file);
    if (executableDigest(privateScript) !== scriptId) throw new Error("an isolated runner differs from its source");
    if (fs.readFileSync(path.join(view, "package.json"), "utf8") !== '{"type":"module"}') throw new Error("an isolated runner has a different module format");
    modulesMatch(path.join(view, "node_modules"), [name]);
    const loadedLink = path.join(view, "node_modules", name);
    if (fs.realpathSync(loadedLink) !== path.join(view, "packages", String(roots[1] ?? roots[0]))) throw new Error("an isolated runner resolves a different package");
    for (let parent = path.dirname(view); ; parent = path.dirname(parent)) {
      if (observeLocation(path.join(parent, "node_modules"))) throw new Error("an isolated installation has ambient modules");
      if (parent === path.dirname(parent)) break;
    }
    if (observeLocation(path.join(view, "packages", "node_modules"))) throw new Error("isolated packages have ambient modules");
    if (!sameFiles(observations, links)) throw new InstallationChanged();
    return { entry: privateEntry, script: privateScript };
  };
  return { graph, roots, main, contents, observeLocation, isolate, files: observations, links, unchanged: () => sameFiles(observations, links) };
}

export const installedPackages = (exe: string, name: string) => packageGraph(exe, name).graph.map((p) => p.version).sort();

let programSource: string | undefined;
export function installedProgram(root: string, tool: keyof typeof TOOL_PACKAGES): Program | undefined {
  const scope = checking.getStore();
  const key = `${tool}\0${path.resolve(root)}`;
  if (scope?.programs.has(key)) return scope.programs.get(key);
  const exe = findBin(tool, root);
  if (!exe) {
    scope?.programs.set(key, undefined);
    return undefined;
  }
  let previous = latest.get(tool);
  if (previous?.exe !== exe || !previous.unchanged()) {
    const searchPath = process.env.NODE_PATH;
    const commandPath = process.env.PATH;
    const nodeOptions = nodeFlags();
    const key = sha(programSource ??= code(closure("cache")), import.meta.dirname, path.resolve(exe), searchPath ?? "", commandPath ?? "", nodeOptions ?? "", process.execPath, process.version, process.platform, process.arch);
    const name = `installed-${key.slice(0, 24)}.json.zst`;
    const directory = path.join(path.dirname(LASTING), "installations");
    const index = path.join(directory, name);
    let installed: { id: string; isolated: Isolated; unchanged: () => boolean } | undefined = unsure || previous?.exe === exe ? undefined : readProgram(index, key);
    if (!installed) {
      const inventory = packageGraph(exe, TOOL_PACKAGES[tool]);
      const { graph, roots, main, contents, observeLocation, isolate, files, links, unchanged } = inventory;
      try {
        const launcher = launcherInputs(exe, main, observeLocation);
        if (launcher) {
          const expected = graph.map(({ dir }) => contents(dir));
          const id = sha(launcher.digest, JSON.stringify([roots, graph.map(({ version, dependencies }, index) => [version, expected[index], dependencies])]), `node@${process.versions.node}:${process.platform}:${process.arch}`);
          const isolated = isolate(id, launcher.entry, expected);
          installed = { id, isolated, unchanged };
          if (!unsure) {
            try {
              writeWhole(index, zstdCompressSync(JSON.stringify([key, id, [...files], [...links], isolated])));
              pruneCache(directory, new Set([name]), (file) => /^installed-[a-f0-9]{24}\.json\.zst$/.test(file));
            } catch { /* optional cache */ }
          }
        }
      } catch (error) { if (error instanceof InstallationChanged) throw error; }
      const stable = () => process.env.NODE_PATH === searchPath && process.env.PATH === commandPath && nodeFlags() === nodeOptions && unchanged();
      latest.set(tool, previous = installed ? { exe, ...installed, unchanged: stable } : { exe, id: undefined, unchanged: stable });
    } else {
      const stable = installed.unchanged;
      latest.set(tool, previous = { exe, ...installed, unchanged: () => process.env.NODE_PATH === searchPath && process.env.PATH === commandPath && nodeFlags() === nodeOptions && stable() });
    }
  }
  const program: Program = { ...previous, unchanged: () => findBin(tool, root) === exe && previous.unchanged() };
  scope?.programs.set(key, program);
  return program;
}

export function evaluatorForCheck(root: string): string | undefined {
  const scope = checking.getStore();
  const known = scope?.evaluators.get(root);
  if (known) return known;
  const id = evaluatorIdentity(root);
  if (id) scope?.evaluators.set(root, id);
  return id;
}

export function stableInstallation(same: boolean) {
  const scope = checking.getStore();
  if (!same && scope) scope.changed = true;
  return same;
}

/**
 * What is read of Dafny once for its installation as it is now: its launchers and its assemblies. A
 * process that outlives a reinstall, as `watch` does, reads it again. A value `kept` refuses is read again next time.
 */
function perDafny<T>(read: () => Promise<T>, kept: (value: T) => boolean = () => true): () => Promise<T> {
  const known = new Map<string, Promise<T>>();
  return () => {
    const { files, at } = installation();
    if (!files) return read();
    let value = known.get(at);
    if (!value) known.set(at, value = read().then((v) => { if (!kept(v)) known.delete(at); return v; }, (e) => { known.delete(at); throw e; }));
    return value;
  };
}

/** The version of Dafny on the PATH, or why it could not be read: asked of Dafny only when its installation changed. */
export const dafnyVersion = perDafny(async (): Promise<{ version?: string; problem?: string }> => {
  try {
    const { files } = installation();
    const installed = files && lasting(`dafny --version ${files[0]}`, files);
    if (installed?.value) return dafnySaid(installed.value);
    const r = await exec("dafny", ["--version"], process.cwd());
    const version = r.status === 0 ? r.stdout.match(/\d+\.\d+\.\d+/)?.[0] : undefined;
    if (version && !r.stopped) installed?.keep(version);
    return dafnySaid(version, r.stopped, `${r.stdout}${r.stderr}`);
  } catch (e) {
    return { problem: `Dafny could not be run (${(e as Error).message}): ${NEEDS_DAFNY}` };
  }
}, (r) => !r.problem);

/** The verifier's launchers, managed assemblies, and any separately installed .NET host, by their bytes. */
export const dafnyIdentity = perDafny(async () => {
  const { launchers, assemblies, runtime } = dafnyInstallation();
  return { version: (await dafnyVersion()).version, launchers: launchers.map(executableDigest), assemblies: treeDigest(assemblies), runtime: runtime.map((dir) => [path.basename(dir), treeDigest(dir)]) };
});

/** Dafny, told apart by its installation and the solver it is given. */
export const verifierIdentity = perCheck(async () => {
  const [dafny, z3] = await Promise.all([dafnyIdentity(), solver()]);
  return JSON.stringify({ dafny, z3: `${z3.version}:${executableDigest(z3.path)}`, platform: `${process.platform}:${process.arch}` });
});
/** The verifier as installed now, even within a check: whether it was installed again while a tool ran. */
export const verifiedNow = () => checking.exit(verifierIdentity);

class SolverUnavailable extends Error {}

/**
 * The solver selected by Dafny's installation, pinned for every proof and recorded in its cache key; selected again once
 * per check from the bundled candidates and Z3 on the PATH. A candidate's version is asked of it only once it changed.
 */
export const solver = perCheck(async () => {
  const dafny = onPath("dafny");
  const z3 = onPath("z3");
  const candidates: string[] = [];
  if (dafny) {
    const real = fs.realpathSync(dafny);
    for (const dir of [path.dirname(real), path.join(path.dirname(real), "..", "libexec")]) {
      const bundled = path.join(dir, "z3", "bin");
      if (!fs.existsSync(bundled)) continue;
      const preferred = (name: string) => name.includes("4.12.1") ? 0 : name.includes("4.8.5") ? 1 : 2;
      candidates.push(...fs.readdirSync(bundled).filter((name) => /^z3(-\d+(\.\d+)*)?(\.exe)?$/.test(name))
        .sort((a, b) => preferred(a) - preferred(b) || a.localeCompare(b)).map((name) => path.join(bundled, name)));
    }
  }
  if (z3) candidates.push(z3);
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      const { value, keep } = lasting(`z3 --version ${candidate}`, [candidate, real]);
      if (value) return { path: real, version: value };
      const result = await exec(candidate, ["--version"], path.dirname(candidate));
      const version = result.status === 0 && !result.stopped && result.stdout.match(/Z3 version (\d+\.\d+\.\d+)/)?.[1];
      if (version) return { path: real, version: keep(version) };
    } catch { /* try the next solver supplied by this installation */ }
  }
  throw new SolverUnavailable("the proof stage needs the Z3 solver bundled with Dafny or on the PATH");
});
/** The native toolchain that a Turbo task's inputs cannot read from the repository. */
export async function toolchainFingerprint() {
  const z3 = await solver().catch((error: unknown) => {
    if (error instanceof SolverUnavailable) return null;
    throw error;
  });
  const { findBinary } = await import("vibelang/binary");
  const compiler = findBinary();
  for (const executable of [process.execPath, compiler]) fs.accessSync(executable, fs.constants.X_OK);
  if (z3) fs.accessSync(z3.path, fs.constants.X_OK);
  return {
    platform: process.platform, arch: process.arch,
    node: { version: process.versions.node, digest: executableDigest(process.execPath) },
    dafny: onPath("dafny") ? await dafnyIdentity() : null,
    z3: z3 && { version: z3.version, digest: executableDigest(z3.path) },
    vibelang: { version: packageVersion("vibelang"), digest: executableDigest(compiler) },
    packages: ["@informalsystems/quint", "lemmascript", "vibelang-runtime", "vibelang-vite", "typescript", "vitest", "effect", "@effect/platform-node", "@effect/vitest"].map(packageVersion),
  };
}

const ext = path.extname(import.meta.filename);
/** A tool's imports of other tools that run with it, as it starts or once it asks for them: `import type` and `export type` load nothing. */
const IMPORT = /(?:^(?:import\s+(?!type\b)(?:[^;"]*?\bfrom\s+)?|export\s+(?!type\b)[^;"]*?\bfrom\s+)|\bimport\(\s*)"(\.\.?\/[^"$]+)"/gm;
/** The tools' directories: their commands, the generator, and what a project's tests, stories and design tokens load of them. */
const TOOL_DIRS = ["", "gen", "testing", "stories", "design"];
/**
 * The tools' own scripts, as source or as built: `TOOL_DIRS`, never the projects below them (examples, Studio, the
 * tools' own tests), whose checks rewrite their gen/ while this one reads, and every script they import. Read once, as
 * this process loads them, so that a key names the code that runs, however the files change after. A script is named
 * by its tokens and the line breaks between them, which decide what it does, and not by its comments or indentation,
 * so that rewording a comment runs nothing again; that name is remembered across processes while the file is
 * unchanged, from before it was read.
 */
const tools = new Map<string, { code: string; imports: string[] }>();
const load = (f: string) => {
  if (tools.has(f)) return;
  const file = path.join(import.meta.dirname, f);
  const { value, keep } = lasting(`tokens ${file}`, [file]);
  const text = fs.readFileSync(file, "utf8");
  const imports = [...text.matchAll(IMPORT)].map(([, to]) => path.join(path.dirname(f), to.replace(/\.ts$/, ext)));
  tools.set(f, { code: value ?? keep(sha(...tokenize(text)?.map((t) => `${t.fresh ? "\n" : ""}${t.text}`) ?? [text])), imports });
  imports.forEach(load);
};
TOOL_DIRS.flatMap((dir) => fs.readdirSync(path.join(import.meta.dirname, dir)).map((f) => path.join(dir, f)))
  .filter((f) => f.endsWith(ext) && f !== `selftest${ext}`).sort().forEach(load);
/** The code of these scripts, by their names and tokens. */
const code = (files: string[]) => sha(...files.sort().map((f) => `${f}\0${tools.get(f)?.code}`)).slice(0, 12);
/** Every tool's script, where it is: a page that runs one of them may run any (explore.ts, `pageInputs`). */
export const toolScripts = () => [...tools.keys()].map((f) => path.join(import.meta.dirname, f));
/** The code of every tool, which such a page reads. */
export const toolsCode = () => code([...tools.keys()]);
/** The scripts that run when these do. */
const closure = (...roots: string[]) => {
  const reached = new Set(roots.map((f) => f + ext));
  for (const f of reached) for (const to of tools.get(f)?.imports ?? []) reached.add(to);
  return [...reached];
};

/**
 * Whether a tool, or the set of them, changed between the start of this process and the reading above: then the code it
 * runs may not be the code its keys name, and it remembers nothing. The change time, which a copy or an archive cannot
 * set back, never the modification time.
 */
const unsure = [...TOOL_DIRS, ...tools.keys()].some((f) => fs.statSync(path.join(import.meta.dirname, f)).ctimeMs >= performance.timeOrigin);

/** The stages whose results are remembered, and the runs of an outside tool any of them asks for (action.ts). */
const STAGES = ["simulate", "prove", "types", "tests", "traces", "explore", "action"] as const;
type Stage = (typeof STAGES)[number];

/**
 * What a remembered result of one stage was produced by: the code that runs it, the scripts it imports, and the
 * programs beneath. A simulation depends on Quint, Node and the code that simulates and generates the model it
 * simulates; a proof on Node, LemmaScript, Dafny, Z3 and the prover's code, since its unit's key holds all the unit
 * says, whichever code generated it. The part of the proof library a proof file calls (prove.ts, `libraryFor`) is part
 * of that key too. A typecheck runs VibeLang's compiler, and its key holds every tool's code. Tests, a driver's run and
 * an exploration may run any of these tools, as Studio's do, proofs included, so they depend on the verifier, or on
 * there being none; tests and a driver's run on all the tools' code too, and an exploration on the code that explores:
 * a page that runs the tools has their code in what it reads (explore.ts, `pageInputs`).
 * An action depends only on the code that runs a tool and keeps what it said: its key names the tool and all the tool reads.
 * The versions and the verifier are read for each key, so a process that outlives a reinstall, as `watch` does, keys by
 * what is installed now.
 */
const toolchains = new Map<string, Promise<string>>();
async function toolchainId(root: string, stage: Stage): Promise<string | undefined> {
  const everything = stage === "tests" || stage === "traces" || stage === "explore";
  const proofVerifier = stage === "prove" ? await verifierIdentity() : "";
  const versions = (stage === "action" || stage === "prove" || stage === "simulate" ? []
    : ["@informalsystems/quint", "typescript", "vibelang", ...everything ? ["lemmascript"] : []]).map(packageVersion);
  for (const tool of ["quint", "lsc"] as const) {
    if (!everything && !(tool === "quint" ? stage === "simulate" : stage === "prove")) continue;
    const program = installedProgram(root, tool);
    if (program && !program.id) return undefined;
    versions.push(program?.id ?? `no ${tool} launcher`);
  }
  const verifier = everything ? await verifierIdentity().catch(() => "no verifier") : proofVerifier;
  const known = [stage, ...versions, verifier].join(" ");
  let id = toolchains.get(known);
  if (id) return id;
  toolchains.set(known, (id = (async () => {
    if (stage === "action") return `${stage} ${code([`action${ext}`, `run${ext}`])}`;
    const node = `node@${process.versions.node}:${process.platform}:${process.arch}`;
    if (stage === "prove") return [stage, node, code(closure("prove")), ...versions, verifier].join(" ");
    if (stage === "simulate") return [stage, ...versions, node, code(closure("simulate", "units"))].join(" ");
    const [quint, typescript, vibelang, ...rest] = versions;
    const { findBinary } = await import("vibelang/binary");
    return [stage, quint, node, code(stage === "explore" ? closure("explore") : [...tools.keys()]), typescript, `${vibelang}:${executableDigest(findBinary())}`, ...rest, verifier].filter(Boolean).join(" ");
  })()));
  // A failed probe is not remembered: the next check probes again.
  id.catch(() => toolchains.delete(known));
  return id;
}

/** The remembered results of one check: whether it may read them, and every entry it read or wrote. */
export interface Memory {
  root: string;
  fresh: boolean;
  used: Set<string>;
  actionProjection?: { version: string; encode: (value: unknown) => unknown };
}
/** An entry of `.spec-cache`: JSON, compressed, since a run of the simulator says megabytes. */
interface Entry { name: string; file: string; reusable: boolean; evaluator?: string }
const formats = [["zst", zstdDecompressSync], ["gz", gunzipSync]] as const;
const primaryExtension = `.${formats[0][0]}`;
const localCache = (root: string) => path.join(root, ".spec-cache");
const formalCache = new AsyncLocalStorage<{ directory: string; used: Set<string> }>();
const sharedCache = (name: string) => isActionEntry(name) ? formalCache.getStore() : undefined;
const cacheFile = (root: string, name: string) => path.join(sharedCache(name)?.directory ?? localCache(root), name);

export async function withFormalCache<T>(directory: string, run: () => Promise<T>): Promise<T> {
  const scope = { directory: path.resolve(directory), used: new Set<string>() };
  try {
    return await formalCache.run(scope, run);
  } finally {
    pruneCache(scope.directory, scope.used, isActionEntry);
  }
}

export async function entry(root: string, stage: Stage, key: (string | undefined)[], evaluates = ["simulate", "tests", "traces", "explore"].includes(stage)): Promise<Entry> {
  const evaluator = evaluates ? evaluatorForCheck(root) : undefined;
  const inputs = [await toolchainId(root, stage), ...evaluates ? [evaluator] : [], ...key];
  const reusable = inputs.every((input) => input !== undefined);
  const name = `${stage}-${sha(...inputs.map((input) => input ?? "")).slice(0, 24)}.json${primaryExtension}`;
  return { name, file: cacheFile(root, name), reusable, evaluator };
}
/** Entries are deleted when unused for a while (see collectGarbage), so a hit says the entry is in use. */
function use(memory: Memory, name: string) {
  memory.used.add(name);
  sharedCache(name)?.used.add(name);
  try { const now = new Date(); fs.utimesSync(cacheFile(memory.root, name), now, now); } catch { /* still a hit */ }
}
function projectedEntry(memory: Memory, at: Entry): Entry | undefined {
  if (!memory.actionProjection || !isActionEntry(at.name)) return undefined;
  const raw = at.name.slice(0, -primaryExtension.length);
  const name = `action-${sha("projection", raw, memory.actionProjection.version).slice(0, 24)}.json${primaryExtension}`;
  return { ...at, name, file: cacheFile(memory.root, name) };
}
/** What an entry holds, or undefined. An entry that cannot be read, cut short by a kill or a full disk, is deleted and is a miss. */
export function recall<T>(memory: Memory, raw: Entry): T | undefined {
  const projected = projectedEntry(memory, raw);
  if (!projected) memory.used.add(raw.name);
  const check = checking.getStore();
  if (memory.fresh || !raw.reusable || check?.changed || check?.closed) return undefined;
  const compact = projected && readReceipt<T>(memory, projected);
  if (compact !== undefined) return compact;
  memory.used.add(raw.name);
  return readReceipt<T>(memory, raw);
}

function readReceipt<T>(memory: Memory, { name, file }: Entry): T | undefined {
  const check = checking.getStore();
  const fileBase = file.slice(0, -primaryExtension.length);
  const nameBase = name.slice(0, -primaryExtension.length);
  for (const [extension, decompress] of formats) {
    const stored = `${fileBase}.${extension}`;
    let bytes: Buffer;
    try {
      bytes = check?.pending.get(stored) ?? fs.readFileSync(stored);
    } catch {
      continue;
    }
    try {
      const value = JSON.parse(decompress(bytes).toString("utf8")) as T;
      use(memory, `${nameBase}.${extension}`);
      return value;
    } catch {
      fs.rmSync(stored, { force: true });
    }
  }
  return undefined;
}
/** Remember `value` under an entry, unless this process cannot say which tools computed it: then the next check computes it again. */
export function store(memory: Memory, raw: Entry, value: unknown, action?: { program: Program; began: number }) {
  const { evaluator, reusable } = raw;
  const projected = projectedEntry(memory, raw);
  if (!projected) memory.used.add(raw.name);
  const check = checking.getStore();
  if (unsure || check?.changed || check?.closed || !reusable) return;
  if (evaluator !== undefined && !stableInstallation(evaluatorIdentity(memory.root) === evaluator)) return;
  if (action && !check && !action.program.unchanged()) return;
  const compact = projected && memory.actionProjection?.encode(value);
  const { name, file } = projected && compact !== undefined ? projected : raw;
  const bytes = zstdCompressSync(JSON.stringify(compact === undefined ? value : compact));
  memory.used.add(name);
  sharedCache(name)?.used.add(name);
  if (action) check?.verify.add(action.program);
  else if (check) includePrograms(check);
  if (!check?.verify.size) {
    writeWhole(file, bytes);
    return;
  }
  check.bytes += bytes.length - (check.pending.get(file)?.length ?? 0);
  check.pending.set(file, bytes);
  if (!action || check.pending.size >= MAX_PENDING_ENTRIES || check.bytes >= MAX_PENDING_BYTES
    || performance.now() - Math.min(check.lastPublished, action.began) >= PUBLISH_INTERVAL_MS) publishChecked();
}

/**
 * `produce()`, or what it returned the last time for the same key, if that was
 * worth keeping. This is what keeps a check proportional to what changed. The
 * cache is a convenience: `accept` never reads it. Every entry read or written is recorded as used, so that a
 * full check keeps its results while pruning older branches and profiles. A result also names the entries its
 * producer used, the runs of tools beneath it, and a hit keeps those in use too: a change to these tools asks for the
 * result again, and finds the runs still there.
 */
export async function remembered<T>(memory: Memory, at: Entry | Promise<Entry>, produce: (memory: Memory) => T | Promise<T>, keep: (result: T) => boolean): Promise<T> {
  const e = await at;
  const known = recall<{ result: T; used: string[] }>(memory, e);
  if (known !== undefined) {
    for (const name of known.used) use(memory, name);
    return known.result;
  }
  const own: Memory = { ...memory, used: new Set() };
  const result = await produce(own);
  for (const name of own.used) memory.used.add(name);
  if (keep(result)) store(memory, e, { result, used: [...own.used] });
  return result;
}

const ENTRY = new RegExp(`^(${STAGES.join("|")})-(?:.*-)?[a-f0-9]{24}\\.json\\.(?:${formats.map(([extension]) => extension).join("|")})$`);
export const isActionEntry = (name: string) => name.startsWith("action-") && ENTRY.test(name);
/** Keep recent branches and profiles for a month, within 256 MiB; never evict this check's entries. */
export function collectGarbage(memory: Memory) {
  pruneCache(localCache(memory.root), memory.used);
}

function pruneCache(directory: string, inUse: ReadonlySet<string>, owns?: (name: string) => boolean) {
  if (!fs.existsSync(directory)) return;
  const expired = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const retained: { file: string; size: number; touched: number; used: boolean }[] = [];
  for (const name of fs.readdirSync(directory)) {
    if (name === "lock" || (owns && !owns(name))) continue;
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) continue;
    const used = inUse.has(name);
    if (!used && ((!owns && !ENTRY.test(name)) || !stat.isFile() || stat.mtimeMs < expired))
      fs.rmSync(file, { recursive: true, force: true });
    else retained.push({ file, size: stat.size, touched: stat.mtimeMs, used });
  }
  let bytes = retained.reduce((total, entry) => total + entry.size, 0);
  for (const entry of retained.filter((entry) => !entry.used).sort((a, b) => a.touched - b.touched || a.file.localeCompare(b.file))) {
    if (bytes <= 256 * 2 ** 20) break;
    fs.rmSync(entry.file, { force: true });
    bytes -= entry.size;
  }
}
