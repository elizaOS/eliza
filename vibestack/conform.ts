// The traces stage (SPEC.md, "Conformance"): each package's drivers, `driver:` programs and recorded traces, run
// against its specs with the events the simulator found. conformance.ts does the comparing for all three.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { profile, type TestProfile } from "./testing/profile.ts";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { check, compareObservation, ConformanceError, departure, replay, transition, type Found, type Line, type Oracle, type Sent } from "./conformance.ts";
import type { Model } from "./gen.ts";
import { heading, type Spec } from "./parse.ts";
import type { Step } from "./simulate.ts";
import { exec } from "./run.ts";
import { filesUnder, indent, type Reported } from "./util.ts";

export type Simulated = Found<any> & { traces: Sent<any>[][] };
export interface Machine { domain: Oracle<any, any>; model: Model; found: Simulated }

/** The events and witnessed journeys already examined by the simulator. */
export function conformanceFound(model: Model, spec: Spec, traces: Step[][], witnesses: { w: string; trace: Step[] }[]): Simulated {
  const events = new Map<string, any>();
  for (const { event } of traces.flat()) if (event) events.set(JSON.stringify(event), event);
  for (const { evaluated } of traces.flat()) {
    if (!evaluated) continue;
    const transition = model.transitions.find((t) => t.guard === evaluated.name);
    const sample = [...events.values()].find((event) => event.type === transition?.name);
    if (transition && sample) {
      const event = { ...sample, ...evaluated.picks };
      events.set(JSON.stringify(event), event);
    }
  }
  return {
    spec: model.name, source: model.source, sender: !!model.sender, shape: model.shape!, outputShape: model.outputShape,
    events: [...events.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    journeys: witnesses.map(({ w, trace }) => {
      const rule = spec.rules.find((rule) => rule.defs.includes(w))!;
      return { story: rule.story, rule: heading(rule), events: trace.flatMap((step) => step.event ? [step.event] : []) };
    }),
    traces: traces.slice(0, 100).map((trace) => trace.flatMap((step) => step.event ? [step.event] : [])),
  };
}

/** gen/<name>.conformance.ts: the types a test/drivers/<name>.ts is written to, over a copy of conformance.ts. */
export function writeConformance(root: string, model: Model) {
  if (!model.stateType || !model.transitions.length) return;
  const dir = path.join(root, "gen");
  fs.copyFileSync(path.join(import.meta.dirname, "conformance.ts"), path.join(dir, "_conformance.ts"));
  fs.writeFileSync(path.join(dir, `${model.name}.conformance.ts`), [
    `// Generated from ${model.source}; do not edit. What test/drivers/${model.name}.ts exports, as \`driver\` and \`options\`.`,
    `import type * as oracle from "./${model.name}.ts";`,
    `import type { Driver as Reaching, Options as Choosing } from "./_conformance.ts";`,
    `type State = typeof oracle.initial;`,
    `type Event = Parameters<typeof oracle.step>[1];`,
    `export type Driver<V = State> = Reaching<Event, V>;`,
    `export type Options<V = State> = Choosing<State, V>;`,
    "",
  ].join("\n"));
}

const TRACES = "test/traces", DRIVERS = "test/drivers", COUNTEREXAMPLES = "test/counterexamples";
const ANSWER_WITHIN = 10_000;

/** A real program, one JSON answer for each reset/event request. */
function driver(root: string, command: string) {
  const child = spawn(command, { cwd: root, shell: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let launchError: Error | undefined;
  child.on("error", (error) => { launchError = error; });
  child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-65_536); });
  child.stdin.on("error", () => {});
  const lines = readline.createInterface({ input: child.stdout });
  const answers = lines[Symbol.asyncIterator]();
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  const ask = async (request: Line): Promise<Pick<Line, "state" | "out">> => {
    if (launchError) throw launchError;
    child.stdin.write(`${JSON.stringify(request)}\n`);
    let timer: NodeJS.Timeout | undefined;
    const answer = await Promise.race([answers.next(), new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ANSWER_WITHIN); })]);
    clearTimeout(timer);
    const fail = (message: string): never => { throw new Error(`${message} to ${JSON.stringify(request)}${stderr ? `; stderr: ${stderr}` : ""}`); };
    if (!answer || answer.done) return fail((launchError as Error | undefined)?.message ?? (answer ? "the driver ended without an answer" : `the driver did not answer within ${ANSWER_WITHIN / 1000} seconds`));
    let value: any;
    try { value = JSON.parse(answer.value); } catch { return fail("the driver did not answer with JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "state") || Object.keys(value).some((key) => key !== "state" && key !== "out"))
      return fail("the driver must answer with {state: ..., out?: ...}");
    return value;
  };
  const stop = (signal: NodeJS.Signals) => {
    try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already exited */ }
  };
  return { ask, end: async () => { lines.close(); stop("SIGTERM"); const timer = setTimeout(() => stop("SIGKILL"), 1000); await closed; clearTimeout(timer); } };
}

async function drive(root: string, machine: Machine, command: string): Promise<string | undefined> {
  const { domain, model, found } = machine;
  const program = driver(root, command);
  try {
    for (const [n, events] of found.traces.entries()) {
      const initial = await program.ask({});
      const lines: Line[] = [{ state: initial.state }];
      const resetProblem = compareObservation(domain, found, domain.initial, initial.state);
      if (resetProblem) return `trace ${n + 1}: reset ${resetProblem}`;
      let current = domain.initial;
      const request = ({ by, ...event }: any): Line => model.sender ? { event, by } : { event };
      const send = async (input: Line) => { lines.push({ ...input, ...await program.ask(input) }); };
      // Before each event and after the last, up to two that the spec refuses in that state.
      const refuse = async () => { for (const line of found.events.map(request).filter((line) => !domain.enabled(current, line.event, line.by)).slice(0, 2)) await send(line); };
      for (const sent of events) {
        await refuse();
        const next = request(sent);
        await send(next);
        const applied = transition(domain, found, current, next.event, next.by);
        if (typeof applied === "string") return applied;
        current = applied.after;
      }
      await refuse();
      const off = departure(domain, found, lines);
      if (off) return `trace ${n + 1}, line ${off.line}: ${off.why}\n${lines.map((line) => JSON.stringify(line)).join("\n")}`;
    }
  } finally { await program.end(); }
}

/**
 * The machines whose Effect adapter `apply` the package's `src/` imports: a shell that keeps the machine's state
 * itself, which only a driver compares with the spec. The generated `machine()` needs none: it is the spec's own.
 */
function shelled(root: string): Set<string> {
  const names = new Set<string>();
  for (const file of filesUnder(root, "src").filter((f) => /\.(?:[mc]?tsx?|vibex?)$/.test(f)))
    for (const [, imported, name] of fs.readFileSync(path.join(root, file), "utf8").matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*["'][^"']*\bgen\/(\w+)\.effect\.vibe["']/g))
      if (imported.split(",").some((part) => /^apply\b/.test(part.trim()))) names.add(name);
  return names;
}

/** What `check` writes where a shell has no driver yet: a driver that fails until a person fills it in. */
const stub = (name: string, model: Model) => `// The driver of ${model.source}: how \`pnpm check\` reaches the application to compare it with the spec
// (SPEC.md, "Conformance"). Written by \`spec check\` because src/ keeps the machine's state; fill it in. It imports
// gen/ as types only: the spec is the oracle it is compared with.
import type { Driver } from "../../gen/${name}.conformance.ts";

const todo = (): never => { throw new Error("${DRIVERS}/${name}.ts: fill in reset, dispatch and observe"); };

export const driver: Driver = {
  /** Start from a fresh application: empty storage, nothing created. */
  reset: todo,
  /** Send the event for the entity \`key\` through the application's own entry point: "accepted" or "refused". */
  dispatch: todo,
  /** What the application now holds for \`key\`, read back through its own storage or interface. */
  observe: todo,
};
`;

/**
 * Run `test/drivers/<name>.ts` of the package `root` in a Node of its own that runs VibeLang (`main` below), and say
 * what it found: every saved counterexample, then the journeys, the probes and the walks.
 */
async function driven(root: string, name: string, machine: Machine, mode: TestProfile): Promise<{ problem?: string; summary?: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-driver-")), found = path.join(dir, "found.json");
  fs.writeFileSync(found, JSON.stringify(machine.found));
  const r = await exec(process.execPath, ["--import", "vibelang/register", import.meta.filename, name, found, mode], root).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  const said = r.stdout.trimEnd().split("\n").at(-1) ?? "";
  let verdict: { problem?: string; summary?: string } | undefined;
  try { verdict = JSON.parse(said); } catch { /* not the last line it writes, so the driver never finished */ }
  return verdict ?? { problem: `${DRIVERS}/${name}.ts did not finish${r.stopped ? `: ${r.stopped}` : ""}\n${`${r.stdout}${r.stderr}`.trim().split("\n").slice(-40).join("\n")}` };
}

/** In the driver's own Node, in its package: replay what was saved, then check; a new disagreement is saved. */
async function main(name: string, foundFile: string, mode: TestProfile) {
  const root = process.cwd(), saved = `${COUNTEREXAMPLES}/${name}`;
  const found: Found<any> = JSON.parse(fs.readFileSync(foundFile, "utf8"));
  const oracle: Oracle<any, any> = await import(pathToFileURL(path.join(root, "gen", `${name}.ts`)).href);
  const { driver, options = {} } = await import(pathToFileURL(path.join(root, DRIVERS, `${name}.ts`)).href);
  if (!driver) throw new Error(`${DRIVERS}/${name}.ts exports no \`driver\``);
  const { seed, runs } = profile(mode), walks = Math.min(options.walks ?? Infinity, runs);
  try {
    const files = fs.existsSync(path.join(root, saved)) ? fs.readdirSync(path.join(root, saved)).filter((f) => f.endsWith(".json")).sort() : [];
    for (const file of files) await replay(oracle, found, driver, JSON.parse(fs.readFileSync(path.join(root, saved, file), "utf8")).trace, options, `${saved}/${file}`);
    const { journeys, probes } = await check(oracle, found, driver, { ...options, seed, walks });
    const parts = [[files.length, "saved counterexamples"], [journeys, "journeys"], [probes, "malformed inputs"], [walks, `walks of seed ${seed}`]].filter(([n]) => n);
    return parts.map((p) => p.join(" ")).join(", ");
  } catch (error) {
    if (!(error instanceof ConformanceError) || error.origin === "replay") throw error;
    const file = `${saved}/${createHash("sha256").update(JSON.stringify(error.trace)).digest("hex").slice(0, 12)}.json`;
    fs.mkdirSync(path.join(root, saved), { recursive: true });
    fs.writeFileSync(path.join(root, file), `${JSON.stringify({ origin: error.origin, seed, trace: error.trace }, null, 2)}\n`);
    throw new Error(`${error.message}\nSeed: ${seed}\nSaved as ${file}, which is replayed first from now on.`, { cause: error });
  } finally {
    await driver[Symbol.asyncDispose]?.();
  }
}

if (import.meta.main) {
  const verdict = await main(process.argv[2], process.argv[3], process.argv[4] === "nightly" ? "nightly" : "normal").then((summary) => ({ summary }), (error) => ({ problem: error instanceof Error ? error.message : String(error) }));
  // The last line is the verdict, whatever the driver wrote; a driver may leave a server or a timer running.
  process.stdout.write(`\n${JSON.stringify(verdict)}\n`, () => process.exit());
}

/**
 * Every driver, configured program and recorded trace of the package `root`, run afresh: outside service state is not
 * part of a source-code cache key. A shell with no driver gets one to fill in.
 */
export async function conformance(root: string, machines: Map<string, Machine>, scripts: Record<string, string>, mode: TestProfile = "normal"): Promise<Reported<"traces">[]> {
  const results: Reported<"traces">[] = [];
  const add = (where: string, machine: Machine | undefined, problem: string | undefined, subject: string) => results.push([!problem, "traces",
    `${where}: ${problem ? /^(?:conformance to|trace|line) /.test(problem) ? "the program departs from the spec" : "the run did not get as far as comparing" : `${subject} agree with ${machine!.model.source}${machine!.found.outputShape ? "; effects checked where out is reported" : ""}`}`,
    problem ? indent(problem) : "", where]);
  for (const name of shelled(root)) {
    const file = path.join(root, DRIVERS, `${name}.ts`), model = machines.get(name)?.model;
    if (model && !fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, stub(name, model));
    }
  }
  for (const file of filesUnder(root, DRIVERS).filter((f) => /^test\/drivers\/\w+\.ts$/.test(f))) {
    const name = path.basename(file, ".ts"), machine = machines.get(name);
    const { problem, summary } = machine ? await driven(root, name, machine, mode) : { problem: "no state-machine spec has this name" };
    add(file, machine, problem, summary!);
  }
  const dir = path.join(root, TRACES);
  for (const file of fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => file.endsWith(".jsonl")).sort() : []) {
    const machine = machines.get(file.split(".")[0]);
    const lines = fs.readFileSync(path.join(dir, file), "utf8").trimEnd().split("\n").map((line) => { try { return JSON.parse(line); } catch { return line; } });
    const off = machine && departure(machine.domain, machine.found, lines);
    add(`${TRACES}/${file}`, machine, machine ? off && `line ${off.line}: ${off.why}` : "no state-machine spec has this name", `${lines.length} recorded lines`);
  }
  for (const [name, command] of Object.entries(scripts).filter(([name]) => name.startsWith("driver:"))) {
    const machine = machines.get(name.slice("driver:".length));
    const problem = machine && typeof command === "string" ? await drive(root, machine, command).catch((error: Error) => error.message) : "no state-machine spec has this name, or its driver is not a command";
    add(`script ${name}`, machine, problem, "simulated states and refused events");
  }
  return results;
}
