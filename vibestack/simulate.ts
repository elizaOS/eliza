import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { Model } from "./gen.ts";
import { SENDER } from "./gen/classify.ts";
import { run } from "./run.ts";
import { allDone, digest } from "./util.ts";

export const SAMPLES = 10000;
export const WITNESS_SAMPLES = 20 * SAMPLES;
export const COMPARED_SAMPLES = 2000;
export const REPLAYED = 200;
/** Traces of the first simulation kept, for a spec with `leadsTo` rules, to look for runs that break one (`lasso`). */
export const LASSO_TRACES = 2000;
export const STEPS = 20; // events per trace
/** Trace lengths a search for something reachable tries in turn, the longer ones only if the shorter found nothing. */
export const DEPTHS = [STEPS, 2 * STEPS, 5 * STEPS];

export interface Step {
  event?: { type: string };
  law?: { name: string; args: Record<string, unknown> };
  /** A definition the simulator evaluated: what was picked for its sampled parameters, and what Quint got. */
  evaluated?: { name: string; picks: Record<string, unknown>; result: unknown };
  state?: unknown;
  /** What the event output, in a spec whose transitions may output (gen/classify.ts, `Roles.output`). */
  out?: unknown[];
  /** Whether the last step refined the machine the spec refines (SPEC.md, "Refinement"). */
  refined?: boolean;
  lawsHold?: boolean;
  /** The fair events this state allows, if the spec declares any. */
  fair?: string[];
  /** On a trace's first step: the table it chose for each opaque function, as rows of arguments and result, and the result for anything else. */
  tables?: Record<string, { rows: [unknown[], unknown][]; otherwise: unknown }>;
}

/** A simulated trace; with opaque functions, from the step that settled their tables (gen/harness.ts), and empty if none did. */
function readTrace(file: string, model: Model): Step[] {
  const states = JSON.parse(fs.readFileSync(file, "utf8")).states.filter((st: any) => !model.opaques.length || st.settled);
  return states.map((st: any, i: number): Step => {
    // Values are decoded by their type, and sets put in a fixed order, so that they compare equal to TypeScript's.
    const read = (type: any, itf: any) => model.canon(type, model.decode(type, itf));
    const picked = (ps: { name: string; type: any }[]) => Object.fromEntries(ps.map((p) => [p.name, read(p.type, st["mbt::nondetPicks"][p.name].value)]));
    const taken: string = st["mbt::actionTaken"];
    const t = model.transitions.find((t) => t.name === taken);
    const v = model.evals.find((v) => `eval_${v.name}` === taken);
    const l = model.laws.find((l) => l.name === taken);
    return {
      event: t && { type: t.name, ...picked(t.params) },
      evaluated: v && { name: v.name, picks: picked(v.params.filter((p) => p.from === "pick")), result: read(v.result, st.outcome.value) },
      law: l && { name: l.name, args: picked(l.params) },
      state: model.stateType ? read(model.stateType, st.state) : undefined,
      out: model.output && read(model.output.out, st.emitted),
      refined: model.refines && st.refined,
      lawsHold: st.lawsHold,
      fair: st.fairEnabled?.["#set"],
      tables: i || !model.opaques.length ? undefined : Object.fromEntries(model.opaques.map((o) => [o.name, {
        rows: st[`opaque_${o.name}`]["#map"].map(([k, v]: [any, any]) => [o.params.length === 1 ? [read(o.params[0].type, k)] : k["#tup"].map((x: any, j: number) => read(o.params[j].type, x)), read(o.result, v)]),
        otherwise: read(o.result, st[`opaque_${o.name}_else`]),
      }])),
    };
  });
}

/** Make the generated code's opaque functions answer as the trace's tables do (`opaque` in gen/typescript.ts); returns the domain. */
export function standIn(domain: any, trace: Step[]) {
  for (const [name, { rows, otherwise }] of Object.entries(trace[0]?.tables ?? {}))
    domain.opaque[name] = (...args: unknown[]) => { const row = rows.find(([k]) => isDeepStrictEqual(k, args)); return row ? row[1] : otherwise; };
  return domain;
}

/**
 * The simulator's seed, derived from what is simulated, so that the same harness always gives the same traces and a
 * counterexample can be had again; the fixed test profile gives nightly runs another seed.
 */
const seedFor = (seed: number, ...what: string[]) => String(parseInt(digest([String(seed), ...what].join("\0")).slice(0, 12), 16));

/**
 * Quint installs its evaluator the first time it simulates, and runs started together would race to. Until it is
 * installed, the first run in this process goes alone and the others wait for it; once it is, nothing waits.
 */
let evaluatorInstalled = false;
let firstRun: Promise<void> | undefined;
function evaluatorIsInstalled(root: string): boolean {
  if (evaluatorInstalled) return true;
  for (const from of [import.meta.url, pathToFileURL(path.join(root, "package.json")).href]) {
    let version: string | undefined;
    try { version = fs.readFileSync(createRequire(from).resolve("@informalsystems/quint/dist/src/rust/binaryManager.js"), "utf8").match(/QUINT_EVALUATOR_VERSION = '([^']+)'/)?.[1]; } catch { continue; }
    const home = process.env.QUINT_HOME ?? path.join(os.homedir(), ".quint");
    const exe = process.platform === "win32" ? "quint_evaluator.exe" : "quint_evaluator";
    if (version && fs.existsSync(path.join(home, `rust-evaluator-${version}`, exe))) return (evaluatorInstalled = true);
  }
  return false;
}
async function simulating<T>(root: string, go: () => Promise<T>): Promise<T> {
  if (evaluatorIsInstalled(root)) return go();
  if (firstRun) { await firstRun; return go(); }
  const run = go();
  firstRun = run.then(() => {}, () => {});
  return run;
}

/** Simulated traces per process, at least: below this, a run is not split, since each process costs about a second to start. */
const SHARD_SAMPLES = 1000;
const MAX_SHARDS = 4;

/**
 * Simulate the harness until `invariant` breaks; returns the traces Quint wrote, and the command that runs the same
 * simulation again. One run of Quint uses one core, so with `split` a large budget is split among up to four runs of a
 * single thread, each with a seed of its own; how it is split depends only on the budget, so the same harness always gives
 * the same traces. When a run breaks the invariant, the command is the one for that run.
 */
export async function simulate(root: string, model: Model, invariant: string, traces: number, samples: number, step = "step", split = false, steps = STEPS, seed = 1): Promise<{ broken: boolean; traces: Step[][]; again: string }> {
  const dir = path.join(root, "gen/traces", `${model.name}.${invariant}.${step}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const shards = !split ? 1 : Math.max(1, Math.min(MAX_SHARDS, Math.floor(samples / SHARD_SAMPLES)));
  const runs = Array.from({ length: shards }, async (_, k) => {
    const out = shards === 1 ? dir : path.join(dir, String(k));
    fs.mkdirSync(out, { recursive: true });
    const derivedSeed = seedFor(seed, model.harness, invariant, step, String(samples), String(steps), ...(shards === 1 ? [] : [`${k} of ${shards}`]));
    const args = ["run", `gen/${model.name}.run.qnt`, "--main", `${model.name}_run`, "--step", step, "--invariant", invariant,
      "--max-samples", String(Math.ceil(samples / shards)), "--max-steps", String(steps), "--mbt", "--seed", derivedSeed, ...(shards === 1 ? [] : ["--n-threads", "1"])];
    const r = await simulating(root, () => run("quint", [...args, "--n-traces", String(Math.ceil(traces / shards)), "--out-itf", path.join(out, "{seq}.itf.json")], root));
    const broken = r.out.includes("[violation]");
    // In the order Quint wrote them, so that the same simulation always gives the traces in the same order.
    const files = fs.readdirSync(out).filter((f) => f.endsWith(".itf.json")).sort((x, y) => parseInt(x, 10) - parseInt(y, 10) || x.localeCompare(y));
    const again = `seed ${derivedSeed}; to simulate again: pnpm exec quint ${args.join(" ")}`;
    // Anything other than "held" or "violated", each with a trace, is Quint failing to run.
    if ((!r.ok && !broken) || !files.length) throw new Error(`quint run did not complete (${again}):\n${r.out.trim()}`);
    return { broken, traces: files.map((f) => readTrace(path.join(out, f), model)).filter((t) => t.length), again };
  });
  // Every run finishes before anything is said, so that none is left writing into gen/.
  const done = await allDone(runs);
  return { broken: done.some((d) => d.broken), traces: done.flatMap((d) => d.traces), again: (done.find((d) => d.broken) ?? done[0]).again };
}

/**
 * Look for a state that breaks `invariant`, which is how a goal is shown reachable: in longer traces while none is
 * found, fewer of them as they lengthen, so each depth costs about as many events as `samples` traces of the first.
 */
export async function search(root: string, model: Model, invariant: string, step = "step", depths = DEPTHS, samples = WITNESS_SAMPLES, seed = 1): ReturnType<typeof simulate> {
  let run!: Awaited<ReturnType<typeof simulate>>;
  for (const steps of depths) if ((run = await simulate(root, model, invariant, 1, Math.ceil(samples * STEPS / steps), step, false, steps, seed)).broken) break;
  return run;
}
export const SEARCHED = `${WITNESS_SAMPLES} traces of ${STEPS} events and longer ones up to ${DEPTHS.at(-1)}`;

/**
 * Replay one Quint trace through the TypeScript domain; throws at the first difference. With the model, sets are
 * compared whatever their order and every definition the simulator evaluated is evaluated here too.
 */
export function replay(domain: any, trace: Step[], model?: Model) {
  const differ = (what: string) => new Error(`TypeScript and Quint disagree ${what}`);
  const canon = (type: any, value: unknown) => (model ? model.canon(type, value) : value);
  standIn(domain, trace);
  let s = domain.initial;
  let before = s;
  let emitted: unknown[] = [];
  for (const { event, evaluated, law, state, out, lawsHold } of trace) {
    if (event) {
      // Who sent the event travels beside it, as the program passes it (gen/typescript.ts).
      const { [SENDER]: by, ...carried } = event as Record<string, unknown>;
      if (!domain.enabled(s, carried, by)) throw differ(`on whether ${JSON.stringify(event)} is allowed in ${JSON.stringify(s)}`);
      const next = domain.step(s, carried, by);
      // Where transitions output, `step` returns the state and the output (gen/classify.ts, `Roles.output`).
      [before, s, emitted] = model?.output ? [s, next.state, next.out] : [s, next, []];
      if (model?.output && !isDeepStrictEqual(canon(model.output.out, emitted), out)) throw differ(`on what ${JSON.stringify(event)} outputs in ${JSON.stringify(before)}: TypeScript gives ${JSON.stringify(emitted)}, Quint gives ${JSON.stringify(out)}`);
    } else if (evaluated && model) {
      const v = model.evals.find((v) => v.name === evaluated.name)!;
      const args = v.params.map((p) => (p.from === "state" ? s : p.from === "prev" ? before : p.from === "emitted" ? emitted : evaluated.picks[p.name]));
      const got = canon(v.result, domain[v.name](...args));
      if (!isDeepStrictEqual(got, evaluated.result)) throw differ(`on ${v.name}(${args.map((a) => JSON.stringify(a)).join(", ")}): TypeScript gives ${JSON.stringify(got)}, Quint gives ${JSON.stringify(evaluated.result)}`);
    } else if (law && domain[law.name](...Object.values(law.args)) !== lawsHold)
      throw differ(`on ${law.name}${JSON.stringify(law.args)}: Quint says ${lawsHold}`);
    if (state !== undefined && !isDeepStrictEqual(canon(model?.stateType, s), state)) throw differ(`after ${JSON.stringify(event ?? "init")}: TypeScript reached ${JSON.stringify(s)}, Quint reached ${JSON.stringify(state)}`);
  }
}

/** The first rule a trace breaks, in the spec's words, and how many steps it took; undefined if it breaks none. */
export function firstBreak(domain: any, model: Model, trace: Step[], cite: (def: string) => string): { why: string; steps: number } | undefined {
  standIn(domain, trace);
  let before: unknown;
  for (const [i, { event, law, evaluated, state, out, refined, lawsHold }] of trace.entries()) {
    const found = (why: string) => ({ why, steps: i + 1 });
    if (law && lawsHold === false) return found(`the law ${cite(law.name)} is false for ${JSON.stringify(law.args)}`);
    if (evaluated?.result === false && lawsHold === false && model.laws.some((l) => l.name === evaluated.name))
      return found(`the law ${cite(evaluated.name)} is false in state ${JSON.stringify(state)} with sampled parameters ${JSON.stringify(evaluated.picks)}`);
    const always = model.always.filter((a) => !domain[a](state)).map(cite);
    if (always.length) return found(`a reachable state breaks ${always.join(", ")}`);
    if (refined === false) {
      const { fn, of } = model.refines!;
      const u = event && of.transitions.find((u) => u.name === event.type);
      return found(!event ? `${cite(fn)} does not map the initial state onto ${of.alias}::initial`
        : u ? `${cite(event.type)} is not a step of ${of.alias}: it changes ${fn}, but not as ${of.alias}::${u.name}${u.guard ? `, allowed by ${of.alias}::${u.guard},` : ""} would`
        : `${cite(event.type)} changes ${fn}, but ${of.alias} has no transition ${event.type} for it to be`);
    }
    const steps = event ? model.steps.filter((r) => !domain[r.name](before, ...(r.via ? [event.type] : []), state, ...(r.out ? [out] : []))).map((r) => cite(r.name)) : [];
    if (steps.length) return found(`a step breaks ${steps.join(", ")}`);
    before = state;
  }
}

/**
 * The shortest fair run in a trace that breaks a `leadsTo` rule, and how many loops the trace holds. A run is a lasso: the
 * trace up to state `end`, then for ever either nothing (`loop === end`), which is fair if that state allows no fair event,
 * or the states from `loop` to `end`, equal at both ends, again and again, which is fair if it takes every weakly fair
 * event that each of its states allows and every strongly fair one that any allows. It breaks the rule if some state
 * `from` on it is followed by none, itself included, that the rule relates it to. A rule with a bound (`within_<rule>`)
 * is also broken by a trace in which that many events follow `from` and neither it nor any state they reach is related
 * to it; then `loop === end` is the state the last of them reaches, and `within` the bound.
 */
export function lasso(domain: any, model: Model, trace: Step[]): { broken?: { rule: string; from: number; loop: number; end: number; within?: number }; loops: number } {
  standIn(domain, trace);
  const keys = trace.map((s) => JSON.stringify(s.state));
  const memo = new Map<string, boolean>();
  const relates = (rule: string, i: number, j: number) => {
    const at = `${rule} ${i} ${j}`;
    if (!memo.has(at)) memo.set(at, domain[rule](trace[i].state, trace[j].state));
    return memo.get(at)!;
  };
  const fair = (loop: number, end: number) => {
    const allowed = trace.slice(loop, Math.max(end, loop + 1)).map((s) => s.fair ?? []);
    const taken = trace.slice(loop + 1, end + 1).map((s) => s.event?.type);
    return [...model.fair].every(([e, how]) => taken.includes(e) || !(how === "weak" ? allowed.every((a) => a.includes(e)) : allowed.some((a) => a.includes(e))));
  };
  for (const [rule, within] of model.within)
    for (let from = 0; from < trace.length; from++)
      for (let end = from, taken = 0; end < trace.length && !relates(rule, from, end); end++)
        if (end > from && trace[end].event && ++taken === within) return { broken: { rule, from, loop: end, end, within }, loops: 0 };
  let loops = 0;
  for (let end = 0; end < trace.length; end++)
    for (let loop = 0; loop <= end; loop++) {
      if (loop < end && keys[loop] !== keys[end]) continue;
      if (loop < end) loops++;
      if (!fair(loop, end)) continue;
      for (const rule of model.leadsTo)
        for (let from = 0; from <= end; from++) {
          let answered = false;
          for (let j = Math.min(from, loop); j <= end && !answered; j++) answered = relates(rule, from, j);
          if (!answered) return { broken: { rule, from, loop, end }, loops };
        }
    }
  return { loops };
}

/**
 * What differs between two values, as `path = value` for each part that changed. Records and maps are compared
 * entry by entry; a variant whose tag changed, a list or a scalar is shown whole.
 */
const changes = (a: any, b: any, at = ""): string[] =>
  isDeepStrictEqual(a, b) ? []
  : b === undefined ? [`${at} removed`]
  : [a, b].every((x) => x && typeof x === "object" && !Array.isArray(x)) && a.tag === b.tag
    ? [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => changes(a[k], b[k], at ? `${at}.${k}` : k))
    : [`${at || "state"} = ${JSON.stringify(b)}`];

/**
 * A trace as the initial state, then each event with only what it changed, and what it output if anything, with `marks`
 * on the steps they name. A step not shown leaves the state as it was, so its mark goes on the last one shown before it.
 */
export const showTrace = (trace: Step[], marks: [number, string][] = []) =>
  trace.map((s, at) => ({ ...s, at })).filter((s) => s.at === 0 || s.event || s.lawsHold === false).map(({ event, law, evaluated, state, out, lawsHold, at }, i, shown) => {
    const { type, ...args } = event ?? { type: "" };
    const what = event ? type + (Object.keys(args).length ? JSON.stringify(args) : "") : law ? `${law.name}${JSON.stringify(law.args)}` : evaluated ? `${evaluated.name}${JSON.stringify(evaluated.picks)}` : "initial";
    const result = (law || evaluated) && !event ? String(lawsHold) : i ? [...changes(shown[i - 1].state, state), ...(event && out?.length ? [`out ${JSON.stringify(out)}`] : [])].join(", ") || "no change" : JSON.stringify(state);
    const mark = marks.filter(([m]) => m >= at && m < (shown[i + 1]?.at ?? Infinity)).map(([, text]) => text).join("; ");
    return `      ${what.padEnd(30)} -> ${result}${mark && `   <- ${mark}`}`;
  }).join("\n");
