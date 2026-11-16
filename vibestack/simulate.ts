import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { Model } from "./gen.ts";
import { SENDER } from "./gen/classify.ts";
import { quint, violated, type Input } from "./action.ts";
import { entry, remembered, type Memory } from "./cache.ts";
import { conformanceFound, type Simulated } from "./conform.ts";
import { simulated } from "./gen/harness.ts";
import { codeOf, modules, type Rule, type Spec } from "./parse.ts";
import type { Result } from "./spec.ts";
import { allDone, digest, indent } from "./util.ts";

const SAMPLES = 10000;
const WITNESS_SAMPLES = 20 * SAMPLES;
const WITNESS_PREFLIGHT_SAMPLES = 32;
const COMPARED_SAMPLES = 2000;
const REPLAYED = 200;
/** Traces of the first simulation kept, for a spec with `leadsTo` rules, to look for runs that break one (`lasso`). */
const LASSO_TRACES = 2000;
const STEPS = 20; // events per trace
const DEPTHS = [STEPS, 2 * STEPS, 5 * STEPS];

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
function readTrace(itf: string, model: Model): Step[] {
  const states = JSON.parse(itf).states.filter((st: any) => !model.opaques.length || st.settled);
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
function standIn(domain: any, trace: Step[]) {
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

/** What a spec's runs of Quint share: the check's memory, the model, and every file of Quint its harness reads. */
export interface Harness { memory: Memory; model: Model; files: Record<string, Input> }
/** What a spec's harness reads: its modules, the harness itself, and the spec as the harness reads it where it has opaque functions. */
export function harnessFiles(spec: Spec, specs: Spec[], model: Model): Record<string, Input> {
  const sim = model.opaques.length ? simulated(spec.qnt, model.opaques) : undefined;
  return { ...modules(spec, specs), [`${model.name}.run.qnt`]: { text: model.harness, key: model.harness }, ...(sim ? { [`${model.name}.sim.qnt`]: { text: sim, key: codeOf(sim) } } : {}) };
}

/**
 * Simulate the harness until `invariant` breaks; returns the traces Quint wrote, and the command that runs the same
 * simulation again. One run of Quint uses one core, so with `split` a large budget is split among up to four runs of a
 * single thread, each with a seed of its own; how it is split depends only on the budget, so the same harness always gives
 * the same traces. When a run breaks the invariant, the command is the one for that run. A run that ran is in
 * gen/traces; one remembered (action.ts) is not.
 */
export async function simulate({ memory, model, files }: Harness, invariant: string, traces: number, samples: number, step = "step", split = false, steps = STEPS, seed = 1, sampleLimit = samples): Promise<{ broken: boolean; traces: Step[][]; again: string }> {
  const dir = `gen/traces/${model.name}.${invariant}.${step}`;
  const shards = !split ? 1 : Math.max(1, Math.min(MAX_SHARDS, Math.floor(samples / SHARD_SAMPLES)));
  const runs = Array.from({ length: shards }, async (_, k) => {
    const derivedSeed = seedFor(seed, model.harness, invariant, step, String(samples), String(steps), ...(shards === 1 ? [] : [`${k} of ${shards}`]));
    const main = `${model.name}.run.qnt`;
    const args = ["--main", `${model.name}_run`, "--step", step, "--invariant", invariant,
      "--max-samples", String(Math.ceil(sampleLimit / shards)), "--max-steps", String(steps), "--mbt", "--seed", derivedSeed, "--n-threads", "1"];
    const r = await simulating(memory.root, () => quint(memory, ["run", main, ...args, "--n-traces", String(Math.ceil(traces / shards)), "--out-itf", "{seq}.itf.json"], shards === 1 ? dir : `${dir}/${k}`, files));
    const broken = violated(r);
    // In the order Quint wrote them, so that the same simulation always gives the traces in the same order.
    const written = Object.keys(r.files).filter((f) => f.endsWith(".itf.json")).sort((x, y) => parseInt(x, 10) - parseInt(y, 10) || x.localeCompare(y));
    const again = `seed ${derivedSeed}; to simulate again: pnpm exec quint run gen/${main} ${args.join(" ")}`;
    // Anything other than "held" or "violated", each with a trace, is Quint failing to run.
    if ((!r.ok && !broken) || !written.length) throw new Error(`quint run did not complete (${again}):\n${r.out.trim()}`);
    return { broken, traces: written.map((f) => readTrace(r.files[f], model)).filter((t) => t.length), again };
  });
  // Every run finishes before anything is said, so that none is left writing into gen/.
  const done = await allDone(runs);
  return { broken: done.some((d) => d.broken), traces: done.flatMap((d) => d.traces), again: (done.find((d) => d.broken) ?? done[0]).again };
}

/**
 * Look for a state that breaks `invariant`, which is how a goal is shown reachable: in longer traces while none is
 * found, fewer of them as they lengthen, so each depth costs about as many events as `samples` traces of the first.
 */
export async function search(harness: Harness, invariant: string, step = "step", depths = DEPTHS, samples = WITNESS_SAMPLES, seed = 1): ReturnType<typeof simulate> {
  const searches = depths.map((steps) => ({ steps, budget: Math.ceil(samples * STEPS / steps) }));
  if (searches.length > 1) {
    for (const { steps, budget } of searches) {
      if (budget <= WITNESS_PREFLIGHT_SAMPLES) continue;
      const run = await simulate(harness, invariant, 1, budget, step, false, steps, seed, WITNESS_PREFLIGHT_SAMPLES);
      if (run.broken) return run;
    }
  }
  let run!: Awaited<ReturnType<typeof simulate>>;
  for (const { steps, budget } of searches) if ((run = await simulate(harness, invariant, 1, budget, step, false, steps, seed)).broken) break;
  return run;
}
const SEARCHED = `${WITNESS_SAMPLES} traces of ${STEPS} events and longer ones up to ${DEPTHS.at(-1)}`;

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
function firstBreak(domain: any, model: Model, trace: Step[], cite: (def: string) => string): { why: string; steps: number } | undefined {
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
function lasso(domain: any, model: Model, trace: Step[]): { broken?: { rule: string; from: number; loop: number; end: number; within?: number }; loops: number } {
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
const showTrace = (trace: Step[], marks: [number, string][] = []) =>
  trace.map((s, at) => ({ ...s, at })).filter((s) => s.at === 0 || s.event || s.lawsHold === false).map(({ event, law, evaluated, state, out, lawsHold, at }, i, shown) => {
    const { type, ...args } = event ?? { type: "" };
    const what = event ? type + (Object.keys(args).length ? JSON.stringify(args) : "") : law ? `${law.name}${JSON.stringify(law.args)}` : evaluated ? `${evaluated.name}${JSON.stringify(evaluated.picks)}` : "initial";
    const result = (law || evaluated) && !event ? String(lawsHold) : i ? [...changes(shown[i - 1].state, state), ...(event && out?.length ? [`out ${JSON.stringify(out)}`] : [])].join(", ") || "no change" : JSON.stringify(state);
    const mark = marks.filter(([m]) => m >= at && m < (shown[i + 1]?.at ?? Infinity)).map(([, text]) => text).join("; ");
    return `      ${what.padEnd(30)} -> ${result}${mark && `   <- ${mark}`}`;
  }).join("\n");

/** The one simulation result that is not remembered: anything else comes back the same from the same harness and seed. */
const COULD_NOT_RUN = "the simulator could not run";

/** What simulating a spec found: the `always`, `sometimes` and `replay` results, and what the traces stage checks programs against. */
export interface Simulation { said: Result[]; tested?: Simulated }

/**
 * Simulate one spec and replay its traces through `domain`, its generated module. A spec is not simulated again while
 * what Quint reads is unchanged, and its results are not said again while the rules they cite are where they were, with
 * the definitions they held: the seed is part of what is simulated, so a failure comes back the same. Only a simulator
 * that could not run is tried again.
 */
export function simulation(memory: Memory, spec: Spec, specs: Spec[], model: Model, domain: any, seed: number): Promise<Simulation> {
  const citation = (rule: Rule) => `"${rule.key}" (${spec.file}:${rule.line})`;
  const cite = (def: string) => {
    const rule = spec.rules.find((r) => r.defs.includes(def));
    return rule ? citation(rule) : def;
  };
  const simulationSteps = STEPS + Math.max(0, ...model.within.values());
  const files = harnessFiles(spec, specs, model);
  const key = [...Object.keys(files).sort().map((f) => `${f}\0${files[f].key}`), spec.file, spec.rules.map((r) => `${r.key}\0${r.line}\0${r.defs.join(" ")}`).join("\n"),
    String([SAMPLES, WITNESS_SAMPLES, WITNESS_PREFLIGHT_SAMPLES, COMPARED_SAMPLES, REPLAYED, LASSO_TRACES, simulationSteps, ...DEPTHS, seed])];
  return remembered<Simulation>(memory, entry(memory.root, "simulate", key), async (memory) => {
    const harness: Harness = { memory, model, files };
    const said: Result[] = [];
    let tested: Simulated | undefined;
    /** A result concerns the rules it cites. */
    const say = (ok: boolean, stage: Result["stage"], summary: string, detail = "") => {
      const rules = spec.rules.filter((r) => `${summary}\n${detail}`.includes(citation(r))).map((r) => ({ file: spec.file, key: r.key }));
      said.push({ ok, stage, summary, detail, where: spec.file, ...(rules.length ? { rules } : {}) });
    };
    try {
      type Run = Awaited<ReturnType<typeof simulate>>;
      /**
       * Report the shortest trace of these runs that breaks a rule, cut at the break, with the command that runs
       * the simulation it came from again; false if none breaks one.
       */
      const broke = (runs: Run[]): boolean => {
        const bad = runs.flatMap((run) => run.traces.flatMap((t) => { const b = firstBreak(domain, model, t, cite); return b ? [{ t: t.slice(0, b.steps), why: b.why, again: run.again }] : []; }))
          .sort((x, y) => x.t.length - y.t.length)[0];
        if (!bad) return false;
        const lastEvent = bad.t.findLast((s) => s.event)?.event?.type;
        const guard = model.transitions.find((t) => t.name === lastEvent)?.guard;
        // One repair is always available: refuse the event when its result would break the rule. A reason is better.
        const brokenRule = lastEvent ? model.always.find((a) => !standIn(domain, bad.t)[a](bad.t[bad.t.length - 1].state)) : undefined;
        const hint = lastEvent && !bad.why.startsWith("the law") ? `\n      the last event is ${cite(lastEvent)}${guard ? `; its guard ${guard} let it through` : "; it has no guard"}`
          + (brokenRule ? `\n      if no better reason can be found: refuse ${lastEvent} when its result would break ${brokenRule}` : "") : "";
        say(false, "always", `${bad.why}: fix the model, or add the rule that forbids this trace`, `${showTrace(bad.t)}${hint}\n      ${bad.again}`);
        return true;
      };
      // The first run goes alone: Quint installs its evaluator on first use, and runs started together would race to.
      // The rest are independent and overlap. The probe, in which the simulator also evaluates every definition it
      // can, supplies more traces to replay. Each witness search stops at its goal or at a broken rule, whichever
      // comes first (see the harness). All of them finish before anything is reported, failures included.
      // The usual starting states each get a whole bounded interval after them.
      const sim = await simulate(harness, "inv", model.leadsTo.length ? LASSO_TRACES : REPLAYED, SAMPLES, "step", true, simulationSteps, seed);
      if (broke([sim])) return { said, tested };
      const [probe, ...searches] = await allDone([
        simulate(harness, "inv", REPLAYED, COMPARED_SAMPLES, "probe", true, STEPS, seed),
        ...model.sometimes.map((w) => search(harness, `never_${w}`, "step", DEPTHS, WITNESS_SAMPLES, seed)),
      ]);
      const witnesses = model.sometimes.map((w, i) => ({ w, run: searches[i] }));
      const runs = [sim, probe, ...searches.filter((run) => run.broken)];
      if (broke(runs)) return { said, tested };
      if (sim.broken || probe.broken) throw new Error(`the simulator reports a broken rule that no trace shows (${sim.again})`);
      if (!sim.traces.length && !probe.traces.length) {
        say(false, "always", `no table the simulator chose for ${model.opaques.map((o) => o.name).join(", ")} satisfies the laws stated with them, for every value tried: the laws may contradict each other, or define <name>Values to try results that satisfy them`, `      ${sim.again}`);
        return { said, tested };
      }
      const traces = runs.flatMap((run) => run.traces);
      // Each guard should allow its event in some reachable state and refuse it in another. One that never allows it
      // makes the event impossible, and every rule then holds of it trivially, so nothing else would notice: that
      // fails, as an unreached `sometimes` goal does. One that never refuses it may restate a rule, guard against
      // input from outside, or refuse only beyond the simulator's reach: that is reported, not failed.
      // The traces so far usually show both sides; the simulator searches only for what they do not, and each such
      // search also stops at a broken rule (see the harness), which is then reported as any other.
      const guarded = model.transitions.filter((t) => t.guard);
      const seen = new Map(guarded.map((t) => [t.guard!, { allows: false, refuses: false }]));
      for (const { event, evaluated } of traces.flat()) {
        const fired = event && guarded.find((g) => g.name === event.type);
        if (fired) seen.get(fired.guard!)!.allows = true;
        if (evaluated && seen.has(evaluated.name)) seen.get(evaluated.name)![evaluated.result ? "allows" : "refuses"] = true;
      }
      const neverAllowed: { t: (typeof guarded)[number]; again?: string }[] = [];
      const neverRefused: string[] = [];
      // The harness has a witness invariant for every guard whose arguments the simulator can supply. The searches
      // run at once and are read in the guards' order. Only a guard that never allows its event fails the check, so
      // only that search goes deeper and gets the witness budget; one that never refuses it is only reported.
      const missing = guarded.flatMap((t) => (["allows", "refuses"] as const).filter((side) => !seen.get(t.guard!)![side]).map((side) => ({ t, side })));
      const searched = await allDone(missing.map(({ t, side }) => model.evals.some((v) => v.name === t.guard)
        ? search(harness, `never_${side}_${t.guard}`, "probe", side === "allows" ? DEPTHS : [STEPS], side === "allows" ? WITNESS_SAMPLES : SAMPLES, seed)
        : Promise.resolve(undefined)));
      for (const [i, { t, side }] of missing.entries()) {
        const found = searched[i];
        if (found?.broken) {
          if (broke([found])) return { said, tested };
          seen.get(t.guard!)![side] = true;
          traces.push(...found.traces);
        } else if (side === "refuses") neverRefused.push(t.guard!);
        else neverAllowed.push({ t, again: found?.again });
      }
      // A `leadsTo` rule is broken by a fair run that never gets where it should: one of these traces, then nothing
      // or a loop for ever (simulate.ts, `lasso`).
      const runsOf = sim.traces.map((t) => ({ t, ...lasso(domain, model, t) }));
      const live = runsOf.filter((r) => r.broken).sort((x, y) => x.broken!.end - y.broken!.end)[0];
      if (live) {
        const { rule, from, loop, end, within } = live.broken!;
        const shown = showTrace(live.t.slice(0, end + 1), [[from, `${rule} is owed from here`],
          [loop, within ? "the bound runs out here" : loop === end ? "the run may stop here" : "the run goes round from here"]]);
        say(false, "always", within ? `a run breaks ${cite(rule)} within its bound (\`within_${rule} = ${within}\`): neither the state marked nor the next ${within} that events lead to is one the rule relates it to. Fix the model, or raise the bound`
          : `a fair run breaks ${cite(rule)}: no state after the one marked is one the rule relates it to, and the run ${loop === end
          ? "may stop at the last state, since no fair event is possible there. Declare fair the event that should come next (`fair_<event>`), or fix the model"
          : "may repeat its loop for ever, taking every fair event it must. Fix the model, or declare fair the event that should break the loop (\"strong\" if it is possible only at times)"}`,
        `${shown}\n      ${sim.again}`);
        return { said, tested };
      }
      const loops = runsOf.reduce((n, r) => n + r.loops, 0);
      say(true, "always", `no rule broken in ${SAMPLES + COMPARED_SAMPLES} simulated traces`
        + (model.leadsTo.length ? `, and no fair run that stops or loops in ${sim.traces.length} of them breaks a \`leadsTo\` rule (${loops} loops found)` : ""));
      for (const { w, run } of witnesses) {
        const reached = run.broken && run.traces.some((t) => standIn(domain, t)[w](t.at(-1)?.state));
        say(reached, "sometimes", reached ? `${w} is reachable`
          : `${cite(w)} was not reached in ${SEARCHED}: a guard is too strict, a transition is missing, or the goal needs values the simulator does not try`, reached ? "" : `      ${run.again}`);
      }
      for (const { t, again } of neverAllowed) {
        const causes = ["the guard is too strict", "a transition that leads to the states it needs is missing", `the event becomes possible only after more than ${DEPTHS.at(-1)} events`,
          ...(t.guardParams.length ? [`it needs values the simulator does not try (define ${t.guardParams.map((p) => `${p}Values`).join(" or ")})`] : [])];
        say(false, "sometimes", `${t.name} in ${cite(t.name)} never happened: its guard ${t.guard} refused it in every state reached${again ? ` in ${SEARCHED}` : ""}, so every rule holds of it trivially. Either ${causes.slice(0, -1).join(", ")} or ${causes.at(-1)}`, again ? `      ${again}` : "");
      }
      if (guarded.some((t) => seen.get(t.guard!)!.allows))
        say(true, "sometimes", `${guarded.filter((t) => seen.get(t.guard!)!.allows).length} of ${guarded.length} guards allow their event in some reachable state`
          + (neverRefused.length ? `; never seen to refuse it within ${STEPS} events or for any value tried, so check that each restricts what its rule says: ${neverRefused.join(", ")}` : ", and refuse it in another"));
      for (const t of traces) replay(domain, t, model);
      const compared = new Set(traces.flatMap((t) => t.flatMap((s) => (s.evaluated ? [s.evaluated.name] : []))));
      const missed = [...model.evals.map((v) => v.name).filter((n) => !compared.has(n)), ...model.uncompared];
      say(true, "replay", `generated TypeScript agrees with Quint on ${traces.length} traces: every state${model.laws.length ? ", every law" : ""}, and ${compared.size} definitions evaluated on them`
        + (missed.length ? `; not compared on their own, because the simulator had no arguments for them: ${missed.join(", ")}` : ""));
      if (model.stateType) tested = conformanceFound(model, spec, traces, witnesses.flatMap(({ w, run }) =>
        run.traces.filter((trace) => standIn(domain, trace)[w](trace.at(-1)?.state)).sort((a, b) => a.length - b.length).slice(0, 1).map((trace) => ({ w, trace }))));
    } catch (e) {
      const mismatch = (e as Error).message.startsWith("TypeScript and Quint disagree");
      say(false, mismatch ? "replay" : "always", mismatch ? "this is a bug in the generator (vibestack/gen.ts, vibestack/gen/), not in the spec" : COULD_NOT_RUN, indent((e as Error).message));
    }
    return { said, tested };
  }, ({ said }) => !said.some((r) => r.summary === COULD_NOT_RUN));
}
