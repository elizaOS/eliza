import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { filesUnder, sha, writeWhole } from "./util.ts";
import { dafnyVersion, solver } from "./prove.ts";
import { executableDigest } from "./run.ts";

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

/** Runtime files are keyed by relative name and bytes, never their installation directory. */
const treeDigest = (directory: string) => sha(...filesUnder(directory, ".").filter((file) => fs.statSync(path.join(directory, file)).isFile())
  .map((file) => `${file}\0${executableDigest(path.join(directory, file))}`));

/** The verifier's launcher, managed assemblies, and any separately installed .NET host. */
async function dafnyIdentity() {
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  const launcher = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
    .flatMap((dir) => extensions.map((ext) => path.join(dir, `dafny${ext}`)))
    .find((file) => {
      try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
    });
  if (!launcher) throw new Error("Dafny is not on PATH; the task cache needs its toolchain fingerprint");
  const real = fs.realpathSync(launcher);
  const assemblies = [path.dirname(real), path.resolve(path.dirname(real), "../libexec")]
    .find((dir) => fs.existsSync(path.join(dir, "Dafny.dll")));
  if (!assemblies) throw new Error("Dafny.dll is not beside Dafny or in ../libexec; the task cache cannot fingerprint this installation");
  const launchers: string[] = [];
  let host = real;
  for (;;) {
    const bytes = fs.readFileSync(host);
    launchers.push(executableDigest(host));
    const next = bytes.subarray(0, 2).toString() === "#!" ? bytes.toString().match(/\bexec\s+"([^"\n]*[\\/]dotnet(?:\.exe)?)"/)?.[1] : undefined;
    if (!next) break;
    host = fs.realpathSync(next);
    fs.accessSync(host, fs.constants.X_OK);
    if (launchers.length > 4) throw new Error("Dafny's runtime launcher chain does not terminate");
  }
  const runtime = ["host", "shared"].filter((dir) => fs.existsSync(path.join(path.dirname(host), dir)))
    .map((dir) => [dir, treeDigest(path.join(path.dirname(host), dir))]);
  if (!runtime.length && !fs.existsSync(path.join(assemblies, "System.Private.CoreLib.dll")))
    throw new Error("Dafny's external .NET runtime cannot be fingerprinted; use a self-contained release or an explicit dotnet launcher");
  return { version: (await dafnyVersion()).version, launchers, assemblies: treeDigest(assemblies), runtime };
}

/** The native toolchain that a Turbo task's inputs cannot read from the repository. */
export async function toolchainFingerprint() {
  const z3 = await solver();
  const { findBinary } = await import("vibelang/binary");
  const compiler = findBinary();
  for (const executable of [process.execPath, compiler, z3.path]) fs.accessSync(executable, fs.constants.X_OK);
  return {
    platform: process.platform, arch: process.arch,
    node: { version: process.versions.node, digest: executableDigest(process.execPath) },
    dafny: await dafnyIdentity(),
    z3: { version: z3.version, digest: executableDigest(z3.path) },
    vibelang: { version: packageVersion("vibelang"), digest: executableDigest(compiler) },
    packages: ["@informalsystems/quint", "lemmascript", "vibelang-runtime", "vibelang-vite", "typescript", "vitest", "effect", "@effect/platform-node", "@effect/vitest"].map(packageVersion),
  };
}

const ext = path.extname(import.meta.filename);
/**
 * The tools' own scripts, as source or as built: this directory and gen/, never the projects below it (examples,
 * Studio), whose checks rewrite their gen/ while this one reads. Read once, as this process loads them, so that a key
 * names the code that runs, however the files change after.
 */
const tools = new Map(["", "gen"].flatMap((dir) => fs.readdirSync(path.join(import.meta.dirname, dir)).map((f) => path.join(dir, f)))
  .filter((f) => f.endsWith(ext) && f !== `selftest${ext}`).sort().map((f) => [f, fs.readFileSync(path.join(import.meta.dirname, f), "utf8")]));

/**
 * Whether a tool, or the set of them, changed between the start of this process and the reading above: then the code it
 * runs may not be the code its keys name, and it remembers nothing. The change time, which a copy or an archive cannot
 * set back, never the modification time.
 */
const unsure = ["", "gen", ...tools.keys()].some((f) => fs.statSync(path.join(import.meta.dirname, f)).ctimeMs >= performance.timeOrigin);

/** The stages whose results are remembered, and the runs of an outside tool any of them asks for (action.ts). */
const STAGES = ["simulate", "prove", "tests", "explore", "action"] as const;
type Stage = (typeof STAGES)[number];

/**
 * What a remembered result of one stage was produced by: a different Quint, Node or version of these tools must not
 * reuse a simulation, and a proof also depends on LemmaScript, Dafny and the prover's own code. Each stage has its own,
 * so that a change that matters only to the proof (prove.ts, Dafny, LemmaScript) does not simulate everything again.
 * The part of the proof library a proof file calls (prove.ts, `libraryFor`) is part of its unit's key. An action
 * depends only on the code that runs a tool and keeps what it said: its key names the tool and all the tool reads.
 */
const toolchains = new Map<string, Promise<string>>();
function toolchainId(stage: Stage): Promise<string> {
  let id = toolchains.get(stage);
  if (id) return id;
  toolchains.set(stage, (id = (async () => {
    const code = (files: string[]) => sha(...files.map((f) => `${f}\0${tools.get(f)}`)).slice(0, 12);
    if (stage === "action") return `${stage} ${code([`action${ext}`, `run${ext}`])}`;
    // Only the prover's own file is left out of what a simulation depends on: anything else may be used by both.
    const parts = [stage, packageVersion("@informalsystems/quint"), `node@${process.versions.node}:${process.platform}:${process.arch}`, code([...tools.keys()].filter((f) => stage === "prove" || f !== `prove${ext}`))];
    if (stage === "prove") {
      const z3 = await solver();
      parts.push(packageVersion("lemmascript"), `dafny@${JSON.stringify(await dafnyIdentity())}`, `z3@${z3.version}:${executableDigest(z3.path)}`);
    }
    return parts.join(" ");
  })()));
  // A failed probe is not remembered: the next check probes again.
  id.catch(() => toolchains.delete(stage));
  return id;
}

/** The remembered results of one check: whether it may read them, and every entry it read or wrote. */
export interface Memory { root: string; fresh: boolean; used: Set<string> }
/** An entry of `.spec-cache`: JSON, compressed, since a run of the simulator says megabytes. */
interface Entry { name: string; file: string }
const cacheDir = (root: string) => path.join(root, ".spec-cache");
export async function entry(root: string, stage: Stage, key: string[]): Promise<Entry> {
  const name = `${stage}-${sha(await toolchainId(stage), ...key).slice(0, 24)}.json.gz`;
  return { name, file: path.join(cacheDir(root), name) };
}
/** Entries are deleted when unused for a while (see collectGarbage), so a hit says the entry is in use. */
function use(memory: Memory, name: string) {
  memory.used.add(name);
  try { const now = new Date(); fs.utimesSync(path.join(cacheDir(memory.root), name), now, now); } catch { /* still a hit */ }
}
/** What an entry holds, or undefined. An entry that cannot be read, cut short by a kill or a full disk, is deleted and is a miss. */
export function recall<T>(memory: Memory, { name, file }: Entry): T | undefined {
  memory.used.add(name);
  if (memory.fresh) return undefined;
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return undefined;
  }
  try {
    const value = JSON.parse(gunzipSync(bytes).toString("utf8")) as T;
    use(memory, name);
    return value;
  } catch {
    fs.rmSync(file, { force: true });
    return undefined;
  }
}
/** Remember `value` under an entry, unless this process cannot say which tools computed it: then the next check computes it again. */
export function store(memory: Memory, { name, file }: Entry, value: unknown) {
  memory.used.add(name);
  if (!unsure) writeWhole(file, gzipSync(JSON.stringify(value)));
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

const ENTRY = new RegExp(`^(${STAGES.join("|")})-(?:.*-)?[a-f0-9]{24}\\.json\\.gz$`);
/** Keep recent branches and profiles for a month, within 256 MiB; never evict this check's entries. */
export function collectGarbage(memory: Memory) {
  const directory = cacheDir(memory.root);
  const expired = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const retained: { file: string; size: number; touched: number; used: boolean }[] = [];
  for (const name of fs.readdirSync(directory)) {
    if (name === "lock") continue;
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    const used = memory.used.has(name);
    if (!used && (!ENTRY.test(name) || !stat.isFile() || stat.mtimeMs < expired))
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
