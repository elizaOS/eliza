import fs from "node:fs";
import path from "node:path";
import { entry, recall, store, type Memory } from "./cache.ts";
import { bin, exec, executableDigest } from "./run.ts";

/** A file a tool reads: its text, and what of the text decides the run, which is what the run is remembered under. */
export interface Input { text: string; key: string }

/** What a run of a tool said: its exit status, all it wrote to the terminal, and every file it wrote beside its inputs. */
export interface Ran { ok: boolean; status: number; out: string; stderr: string; stopped?: string; files: Record<string, string> }

/** Whether Quint ended a simulation by finding a state that breaks the invariant: its last word, never its output. */
export const violated = (r: Pick<Ran, "status" | "stderr">) => r.status === 1 && /(?:^|\n)error: Invariant violated$/.test(r.stderr.trimEnd());

/**
 * Whether a run of Quint reached its answer, the only kind remembered: a typecheck that found no error and wrote the IR,
 * or a simulation that held or broke the invariant and wrote its traces. A stopped run, a type error and an error at run
 * time are tried again.
 */
const answered = (args: string[], r: Ran) => !r.stopped && (args[0] === "typecheck" ? r.ok && Object.keys(r.files).length > 0
  : (r.ok || violated(r)) && Object.keys(r.files).some((f) => f.endsWith(".itf.json")));

/** Where Node would find a package from `from`, as installed. */
function installed(name: string, from: string): string | undefined {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const at = path.join(dir, "node_modules", name);
    if (path.basename(dir) !== "node_modules" && fs.existsSync(path.join(at, "package.json"))) return fs.realpathSync(at);
    if (dir === path.dirname(dir)) return undefined;
  }
}

/** A package and every package it may load, by name and version. */
function packages(dir: string, found = new Map<string, string>()): Map<string, string> {
  if (found.has(dir)) return found;
  const { name, version, dependencies, optionalDependencies } = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  found.set(dir, `${name}@${version}`);
  for (const dep of Object.keys({ ...dependencies, ...optionalDependencies })) {
    const at = installed(dep, dir);
    if (at) packages(at, found);
  }
  return found;
}

/**
 * The program `quint` runs as, and what tells it from another: the bytes of its launcher, every package it loads, and
 * the Node and platform that run them.
 */
const programs = new Map<string, { exe: string; id: string }>();
function quintProgram(root: string) {
  const exe = bin("quint", root);
  let program = programs.get(exe);
  if (!program) {
    const at = installed("@informalsystems/quint", path.resolve(exe, "../../.."));
    if (!at) throw new Error(`no @informalsystems/quint is installed beside ${exe}; run pnpm install`);
    program = { exe, id: [executableDigest(exe), ...[...packages(at).values()].sort(), `node@${process.versions.node}:${process.platform}:${process.arch}`].join(" ") };
    programs.set(exe, program);
  }
  return program;
}

/**
 * Run Quint with `args` in `dir`, a directory of the project made anew with only `files` in it, or say what the same run
 * said before. A run is remembered under the program, the arguments and what decides each file, and the code of this
 * file and run.ts: a change elsewhere in these tools runs Quint again only where it changes what Quint reads, and a file
 * left out of `files` is one Quint cannot find. Only a run that reached its answer is remembered, and not when the
 * program was installed again during the check.
 */
export async function quint(memory: Memory, args: string[], dir: string, files: Record<string, Input>): Promise<Ran> {
  const { exe, id } = quintProgram(memory.root);
  const at = await entry(memory.root, "action", [id, JSON.stringify(args), ...Object.keys(files).sort().flatMap((f) => [f, files[f].key])]);
  const known = recall<Ran>(memory, at);
  if (known) return known;
  const where = path.join(memory.root, dir);
  fs.rmSync(where, { recursive: true, force: true });
  fs.mkdirSync(where, { recursive: true });
  for (const [f, { text }] of Object.entries(files)) fs.writeFileSync(path.join(where, f), text);
  const r = await exec(exe, args, where).catch((e: Error) => { throw new Error(`quint could not be run (${exe}): ${e.message}; run pnpm install`); });
  const written = fs.readdirSync(where, { withFileTypes: true }).filter((f) => f.isFile() && !Object.hasOwn(files, f.name)).map((f) => f.name).sort();
  const ran: Ran = { ok: r.status === 0 && !r.stopped, status: r.status, out: `${r.stdout}${r.stderr}${r.stopped ? `\n${r.stopped}\n` : ""}`, stderr: r.stderr, stopped: r.stopped,
    files: Object.fromEntries(written.map((f) => [f, fs.readFileSync(path.join(where, f), "utf8")])) };
  if (answered(args, ran) && fs.statSync(exe).ctimeMs < performance.timeOrigin) store(memory, at, ran);
  return ran;
}
