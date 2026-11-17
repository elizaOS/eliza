import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { filesUnder, sha, tokenize, writeWhole } from "./util.ts";
import { NEEDS_DAFNY, exec, onPath, stamp } from "./run.ts";

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
function lasting(key: string, files: string[]) {
  const now = stamp(files);
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

const treeFiles = (directory: string) => filesUnder(directory, ".").filter((file) => fs.statSync(path.join(directory, file)).isFile());
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
 * Dafny's files and their stamps with Z3's on the PATH, as installed now: read once for each check (`steady`), and on
 * every call outside one.
 */
const checking = new AsyncLocalStorage<{ installation?: { files?: string[]; at: string } }>();
function installation() {
  const now = () => {
    const files = dafnyFiles();
    if (!files) return { at: "" };
    try {
      const z3 = onPath("z3");
      return { files, at: [...files, ...z3 ? [z3, fs.realpathSync(z3)] : []].map((file) => `${file}=${stamp([file])}`).join("\0") };
    } catch (e) {
      return { files, at: (e as Error).message };
    }
  };
  const scope = checking.getStore();
  return scope ? (scope.installation ??= now()) : now();
}
/** Run a check, which reads Dafny's installation once: a reinstall during it is seen by the next check, and by `verifiedNow`. */
export const steady = <T>(run: () => Promise<T>) => checking.run({}, run);

/**
 * What is read of Dafny once for its installation as it is now: its launchers, its assemblies and Z3 on the PATH. A
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
export const verifierIdentity = perDafny(async () => {
  const [dafny, z3] = await Promise.all([dafnyIdentity(), solver()]);
  return JSON.stringify({ dafny, z3: `${z3.version}:${executableDigest(z3.path)}`, platform: `${process.platform}:${process.arch}` });
});
/** The verifier as installed now, even within a check: whether it was installed again while a tool ran. */
export const verifiedNow = () => checking.exit(verifierIdentity);

/**
 * The solver selected by Dafny's installation, pinned for every proof and recorded in its cache key; selected again once
 * Dafny or Z3 on the PATH is another or installed again. A candidate's version is asked of it only once it changed.
 */
const selected = new Map<string, Promise<{ path: string; version: string }>>();
export function solver(): Promise<{ path: string; version: string }> {
  const dafny = onPath("dafny");
  const z3 = onPath("z3");
  const installed = [dafny, z3].map((f) => f ? `${f}=${stamp([f, fs.realpathSync(f)])}` : "").join("\0");
  let chosen = selected.get(installed);
  if (!chosen) selected.set(installed, chosen = (async () => {
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
    throw new Error("the proof stage needs the Z3 solver bundled with Dafny or on the PATH");
  })().catch((e) => { selected.delete(installed); throw e; }));
  return chosen;
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
async function toolchainId(stage: Stage): Promise<string> {
  const everything = stage === "tests" || stage === "traces" || stage === "explore";
  const versions = (stage === "action" ? [] : stage === "prove" ? ["lemmascript"] : stage === "simulate" ? ["@informalsystems/quint"]
    : ["@informalsystems/quint", "typescript", "vibelang", ...everything ? ["lemmascript"] : []]).map(packageVersion);
  const verifier = stage === "prove" ? await verifierIdentity() : everything ? await verifierIdentity().catch(() => "no verifier") : "";
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
