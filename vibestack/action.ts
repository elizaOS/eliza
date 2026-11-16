import fs from "node:fs";
import path from "node:path";
import { dafnyIdentity, entry, executableDigest, recall, store, type Memory } from "./cache.ts";
import { NEEDS_DAFNY, bin, exec, solver } from "./run.ts";

/** A file a tool reads: its text, and what of the text decides the run, which is what the run is remembered under. */
export interface Input { text: string; key: string }

/** What a run of a tool said: its exit status, all it wrote to the terminal, and every file it wrote beside its inputs. */
export interface Ran { ok: boolean; status: number; out: string; stderr: string; stopped?: string; files: Record<string, string> }

/** Whether Quint ended a simulation by finding a state that breaks the invariant: its last word, never its output. */
export const violated = (r: Pick<Ran, "status" | "stderr">) => r.status === 1 && /(?:^|\n)error: Invariant violated$/.test(r.stderr.trimEnd());

/** Dafny's closing line, with the failures it counts beside its errors. */
const DAFNY_SUMMARY = /^Dafny program verifier finished with \d+ verified, \d+ errors?((?:, \d+ [a-z ]+)*)$/m;

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

/** The program a tool runs as: where it is, what tells it from another, and the file that changes when it is installed again. */
interface Program { exe: string; id: string; since?: string }
const programs = new Map<string, Promise<Program>>();

/** An executable of the toolchain's dependencies, told apart by its launcher, every package it loads, and the Node and platform that run them. */
function packaged(root: string, cmd: string, name: string): Program {
  const exe = bin(cmd, root);
  const at = installed(name, path.resolve(exe, "../../.."));
  if (!at) throw new Error(`no ${name} is installed beside ${exe}; run pnpm install`);
  return { exe, id: [executableDigest(exe), ...[...packages(at).values()].sort(), `node@${process.versions.node}:${process.platform}:${process.arch}`].join(" "), since: exe };
}

/** Whether Dafny refused a file it could not parse or resolve, which it does again for the same file. */
const refused = (r: Ran) => r.status === 2 && /^\d+ (?:resolution\/type|parse) errors? detected in /m.test(r.out);

/** Whether LemmaScript refused its input, as it does again for the same input: an error of its own, not of the system it runs on. */
const declined = (r: Ran) => r.status === 1 && /^(?:ERROR|WARNING): /m.test(r.stderr) && !/\bE[A-Z]{2,}: |could not run `git diff`/.test(r.stderr);

/**
 * The tools run as actions. Each names its program: Quint and LemmaScript by the bytes of their launchers, every package
 * they load, and the Node and platform that run them; Dafny by its installation and the solver it is given. And each
 * says whether a run reached its answer, the only kind remembered: a typecheck that found no error and wrote the IR, or
 * a simulation that held or broke the invariant and wrote its traces; LemmaScript generating the Dafny, or refusing its
 * input; Dafny refusing a file it cannot parse or resolve, an audit that completed, or a verification that counts no
 * failure but the ones it would count again, obligations not proved or out of resources. A run that ran out of time or
 * memory, failed for want of a file, a process or a program, or was stopped, is tried again.
 */
const TOOLS = {
  quint: {
    program: (root: string) => packaged(root, "quint", "@informalsystems/quint"),
    answered: (args: string[], r: Ran) => args[0] === "typecheck" ? r.ok && Object.keys(r.files).length > 0
      : (r.ok || violated(r)) && Object.keys(r.files).some((f) => f.endsWith(".itf.json")),
  },
  lsc: {
    program: (root: string) => packaged(root, "lsc", "lemmascript"),
    answered: (_args: string[], r: Ran) => declined(r) || (r.ok && Object.keys(r.files).some((f) => f.endsWith(".dfy.gen"))),
  },
  dafny: {
    program: async (): Promise<Program> => {
      const [dafny, z3] = await Promise.all([dafnyIdentity(), solver()]);
      return { exe: "dafny", id: JSON.stringify({ dafny, z3: `${z3.version}:${executableDigest(z3.path)}`, platform: `${process.platform}:${process.arch}` }) };
    },
    answered: (args: string[], r: Ran) => refused(r) || (args[0] === "audit" ? /Dafny auditor completed/.test(r.out)
      : (r.status === 0 || r.status === 4) && !/timed out|out of memory|solver exception|inconclusive/i.test(r.out)
        && (r.out.match(DAFNY_SUMMARY)?.[1].split(", ").filter(Boolean).every((counted) => counted.endsWith(" out of resource")) ?? false)),
  },
};

/**
 * Run a tool with `args` in `dir`, a directory of the project or an absolute one, made anew with only `files` in it, or
 * say what the same run said before. A run is remembered under the program, the arguments and what decides each file,
 * and the code of this file and run.ts: a change elsewhere in these tools runs the tool again only where it changes
 * what the tool reads, and a file left out of `files` is one the tool cannot find. Only a run that reached its answer
 * is remembered, and not when the program was installed again during the check.
 */
export async function act(memory: Memory, tool: keyof typeof TOOLS, args: string[], dir: string, files: Record<string, Input>): Promise<Ran> {
  const { program, answered } = TOOLS[tool];
  const key = `${tool}\0${memory.root}`;
  if (!programs.has(key)) programs.set(key, Promise.resolve(memory.root).then((root) => program(root)).catch((e) => { programs.delete(key); throw e; }));
  const { exe, id, since } = await programs.get(key)!;
  const at = await entry(memory.root, "action", [id, JSON.stringify(args), ...Object.keys(files).sort().flatMap((f) => [f, files[f].key])]);
  const known = recall<Ran>(memory, at);
  if (known) return known;
  const where = path.resolve(memory.root, dir);
  fs.rmSync(where, { recursive: true, force: true });
  fs.mkdirSync(where, { recursive: true });
  for (const [f, { text }] of Object.entries(files)) fs.writeFileSync(path.join(where, f), text);
  const r = await exec(exe, args, where).catch((e: Error) => { throw new Error(`${tool} could not be run (${exe}): ${e.message}; ${tool === "dafny" ? NEEDS_DAFNY : "run pnpm install"}`); });
  const written = fs.readdirSync(where, { withFileTypes: true }).filter((f) => f.isFile() && !Object.hasOwn(files, f.name)).map((f) => f.name).sort();
  const ran: Ran = { ok: r.status === 0 && !r.stopped, status: r.status, out: `${r.stdout}${r.stderr}${r.stopped ? `\n${r.stopped}\n` : ""}`, stderr: r.stderr, stopped: r.stopped,
    files: Object.fromEntries(written.map((f) => [f, fs.readFileSync(path.join(where, f), "utf8")])) };
  if (!ran.stopped && answered(args, ran) && !(since && fs.statSync(since).ctimeMs >= performance.timeOrigin)) store(memory, at, ran);
  return ran;
}
