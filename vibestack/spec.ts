#!/usr/bin/env node
// The spec pipeline and command line. Parsing, review, generation, simulation and proof each have one implementation.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Model } from "./gen.ts";
import { conformance, conformanceFound, type Machine, type Simulated } from "./conform.ts";
import { ensuresOf, LIB_FILE, dafnyVersion, proofPaths, prove, type Offered, type Proof } from "./prove.ts";
import { bin, run } from "./run.ts";
import { readSpecs, badSpecName, specFiles, specName, importedMeanings, isStd, located, type Spec } from "./parse.ts";
import { contracts, pending, pendingKey, pendingContracts, acceptAllReviews, pendingSpecs, migrateLocks, moved, showPending, ledgerFile, readLedger, writeLedger, type Pending, type Accepted, type Lock } from "./review.ts";
import { cacheCredentials, entry, remembered, collectGarbage, toolchainFingerprint, type Memory } from "./cache.ts";
import { generated, mirrorGen, typecheckAll, proofUnits, proofFiles, strayProofFiles } from "./units.ts";
import { SAMPLES, WITNESS_SAMPLES, COMPARED_SAMPLES, REPLAYED, LASSO_TRACES, STEPS, DEPTHS, SEARCHED, simulate, search, firstBreak, lasso, showTrace, replay, standIn } from "./simulate.ts";
import { sha, indent, packageScripts, tests, VITEST_CONFIG, readSrc, codeDirs, codeDirOf, projectRoot, allDone, nodeRunsVibelang, type Reported, type SrcFile } from "./util.ts";
import { profile, type TestProfile } from "./testing/profile.ts";

export { readSpecs, parseSpec, expandListHelpers, type Spec, type Rule, type Story } from "./parse.ts";
export { pending, pendingKey, pendingContracts, acceptReviews, acceptContracts, dependencies, type Lock, type Pending } from "./review.ts";
export { generated, typecheckAll, checkVerifiedSource } from "./units.ts";
export { replay, type Step } from "./simulate.ts";
export { danglingCitations } from "./util.ts";
export { scanSpec } from "./scan.ts";

export interface Result { ok: boolean; stage: "model" | "always" | "sometimes" | "replay" | "types" | "proof" | "tests" | "traces" | "review" | "skipped"; summary: string; detail: string; where?: string }
export const show = ({ ok, stage, summary, detail }: Result) => `${stage === "skipped" ? "-" : ok ? "✓" : "✗"} ${stage.padEnd(9)} ${summary}${detail ? "\n" + detail.trimEnd() : ""}`;

/** The one simulation result that is not remembered: anything else comes back the same from the same harness and seed. */
const COULD_NOT_RUN = "the simulator could not run";

/** Whether `accept` can record a check: every stage but review passed, every story has rules and every rule has Quint. */
export const acceptable = (results: Result[]) => results.every((r) => r.ok || r.stage === "review") && !results.some((r) => !r.ok && /story has no rules|not formalized/.test(r.detail));

/** The one most useful thing to do after a check, given what it found. */
export function nextStep(results: Result[]): string {
  const first = results.find((r) => !r.ok && r.stage !== "review");
  const about = first?.where ? ` (${first.where})` : "";
  if (first) {
    const what: Record<string, string> = {
      model: "fix the spec where the model stage points",
      always: "read the trace: fix the model, or add the rule that forbids it",
      sometimes: "make the goal reachable: loosen the guard, add the transition, or define <param>Values",
      replay: "the generated TypeScript disagrees with Quint, a bug in the tools: report it",
      types: "update src/ and test/ to the generated contract",
      proof: "prove what is listed in the unit's proof file, or fix what Dafny could not check",
      tests: "fix the application or its tests",
      traces: "fix the program where it departs from the spec, or the spec if the program is right",
    };
    // A counterexample the traces stage saved is replayed first from now on, until one side changes.
    const saved = first.stage === "traces" && first.detail.match(/Saved as (\S+), which/)?.[1];
    if (saved) return `${first.stage}${about} is the first ✗: it saved the counterexample ${saved}. Decide which side is wrong: fix the application if the spec says what the user wants, or else the spec; then run \`pnpm check\` again, which replays it first`;
    return `${first.stage}${about} is the first ✗: ${what[first.stage]}, then run \`pnpm check\` again`;
  }
  if (results.every((r) => r.ok)) return "all green";
  if (!acceptable(results)) return "write the rules and Quint the review items ask for, then run `pnpm check` again";
  return "read each review item above; when prose and Quint agree, the user runs `pnpm accept`";
}

/** Take the project's lock for one check or accept at a time; returns what releases it. A lock left by a process that has ended is taken over. */
function lockProject(root: string): () => void {
  const file = path.join(root, ".spec-cache", "lock");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const alive = (pid: number) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(file, `${process.pid}\n`, { flag: "wx" });
      return () => fs.rmSync(file, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let holder = NaN;
    try { holder = parseInt(fs.readFileSync(file, "utf8"), 10); } catch { /* removed in the meantime */ }
    if (alive(holder) || attempt) throw new Error(`another check or accept is running in this project (process ${holder}); wait for it to finish. If no such process is running, delete ${path.relative(root, file)}`);
    fs.rmSync(file, { force: true });
  }
}

/**
 * Run every check, cheapest first, and return what each found and the next
 * thing to do; `log` hears of each result as it arrives. Stages after a broken
 * model are skipped, and said to be, because their failures would only restate
 * the first one. `accept` is "reviews" to record reconciled stories, rules and
 * contracts, or "unproved" to record the obligations that are simulated but not
 * proved; either way nothing remembered from an earlier run is used. Only one
 * check or accept runs in a project at a time; another is refused.
 */
export async function check(root: string, accept: false | "reviews" | "unproved" = false, log: (result: Result) => void = () => {}, mode: TestProfile = "normal"): Promise<{ ok: boolean; results: Result[]; next: string }> {
  // The tests stage names the project that is checking: checking it again from its tests, or from an owner's, which are
  // below it, would wait on its lock or rewrite the gen/ those tests read.
  const fromTests = process.env.SPEC_TESTS ? path.relative(process.env.SPEC_TESTS, fs.realpathSync(root)) : undefined;
  if (fromTests !== undefined && fromTests.split(path.sep)[0] !== ".." && !path.isAbsolute(fromTests)) throw new Error("a test script cannot run spec check or accept: the check already runs the tests");
  const release = lockProject(root);
  try {
    const results: Result[] = [];
    const ok = await checkLocked(root, accept, (r) => { results.push(r); log(r); }, mode);
    return { ok, results, next: nextStep(results) };
  } finally {
    release();
  }
}

async function checkLocked(root: string, accept: false | "reviews" | "unproved", log: (result: Result) => void, mode: TestProfile): Promise<boolean> {
  const { seed } = profile(mode);
  let allOk = true;
  const report = (ok: boolean, stage: Result["stage"], summary: string, detail = "", where?: string, keepDetail = false) => {
    allOk &&= ok;
    log({ ok, stage, summary, detail: ok && !keepDetail ? "" : detail, ...(where ? { where } : {}) });
  };
  const skip = (stages: string, why: string) => report(true, "skipped", `${stages}: ${why}`);
  /** The cache entries this run uses stay; recent entries of other branches and profiles survive pruning. */
  const memory: Memory = { root, fresh: !!accept || mode === "nightly", used: new Set() };
  let specs: Spec[];
  let srcFiles: SrcFile[];
  const proofInputs = () => proofFiles(root).map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]);
  let proofsRead: string[][];
  let pendingLedger: { ledger: Record<string, Accepted>; accepted: Record<string, Accepted | undefined> } | undefined;
  try {
    srcFiles = readSrc(root);
    proofsRead = proofInputs();
    specs = readSpecs(root);
    pendingSpecs(root, specs);
  } catch (e) {
    report(false, "model", (e as Error).message);
    return false;
  }
  fs.rmSync(path.join(root, "gen"), { recursive: true, force: true }); // nothing stale survives a rename
  const valid: Spec[] = [];
  const models = new Map<string, Model>();
  const machines = new Map<string, Machine>();
  const typed = typecheckAll(memory, specs);
  // Node caches imported modules by path, so each run loads its generated code from a directory of its own.
  const loaded = path.join(root, "gen", `run-${Date.now()}`);
  /** Each spec's simulation starts once its model is generated; they run at once and are reported in the specs' order. */
  const simulations: { spec: Spec; model: Model; domain: any; simulated: Promise<{ said: Result[]; tested?: Simulated }> }[] = [];

  for (const spec of specs) {
    const cite = (def: string) => {
      const rule = spec.rules.find((r) => r.defs.includes(def));
      return rule ? `"${rule.key}" (${spec.file}:${rule.line})` : def;
    };
    let model: Model;
    let domain: any;
    try {
      const missing = spec.imports.find((i) => !models.has(i));
      if (missing) throw new Error(`it imports ${missing}, which is not a valid model`);
      model = generated(root, spec, await typed.get(spec.name)!, models);
      fs.mkdirSync(loaded, { recursive: true });
      fs.copyFileSync(path.join(root, `gen/${spec.name}.ts`), path.join(loaded, `${spec.name}.ts`));
      domain = await import(pathToFileURL(path.join(loaded, `${spec.name}.ts`)).href);
    } catch (e) {
      report(false, "model", `${spec.file} is not a valid model`, indent((e as Error).message.trim()), spec.file);
      skip(`always, sometimes and replay of ${spec.file}`, "it is not a valid model");
      continue;
    }
    valid.push(spec);
    const parts = [[model.transitions.length, "transitions"], [model.always.length, "always"], [model.steps.length, "step"], [model.leadsTo.length, "leadsTo"], [model.sometimes.length, "sometimes"], [model.laws.length, "laws"], [model.opaques.length, "opaque"]];
    report(true, "model", `${spec.file}: ${parts.filter(([n]) => n).map((p) => p.join(" ")).join(", ") || "definitions only"}`, "", spec.file);
    if (!model.stateType && !model.laws.length && !model.evals.length) continue;

    // A spec whose model and harness are unchanged is not simulated again: the seed is part of what is simulated, so a
    // failure comes back the same. Only a simulator that could not run is tried again.
    const simulationSteps = STEPS + Math.max(0, ...model.within.values());
    const simulated = remembered<{ said: Result[]; tested?: Simulated }>(memory, entry(root, "simulate", [importedMeanings(spec, specs), spec.meaning, spec.rules.map((r) => r.key).join("\n"), model.harness, String([SAMPLES, WITNESS_SAMPLES, COMPARED_SAMPLES, REPLAYED, LASSO_TRACES, simulationSteps, ...DEPTHS, seed])]), async () => {
      const said: Result[] = [];
      let tested: Simulated | undefined;
      const say = (ok: boolean, stage: Result["stage"], summary: string, detail = "") => said.push({ ok, stage, summary, detail });
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
        const sim = await simulate(root, model, "inv", model.leadsTo.length ? LASSO_TRACES : REPLAYED, SAMPLES, "step", true, simulationSteps, seed);
        if (broke([sim])) return { said, tested };
        const [probe, ...searches] = await allDone([
          simulate(root, model, "inv", REPLAYED, COMPARED_SAMPLES, "probe", true, STEPS, seed),
          ...model.sometimes.map((w) => search(root, model, `never_${w}`, "step", DEPTHS, WITNESS_SAMPLES, seed)),
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
          ? search(root, model, `never_${side}_${t.guard}`, "probe", side === "allows" ? DEPTHS : [STEPS], side === "allows" ? WITNESS_SAMPLES : SAMPLES, seed)
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
    simulated.catch(() => {}); // a failure is reported in its turn, not as an unhandled rejection
    simulations.push({ spec, model, domain, simulated });
  }
  // Every simulation finishes before anything is reported, so that none is left writing into gen/.
  await Promise.allSettled(simulations.map((s) => s.simulated));
  for (const { spec, model, domain, simulated } of simulations) {
    const { said, tested } = await simulated;
    if (tested) machines.set(model.name, { domain, model, found: tested });
    for (const r of said) report(r.ok, r.stage, r.summary, r.detail, spec.file);
    const ran = new Set(said.map((r) => r.stage));
    const notRun = (["sometimes", "replay"] as const).filter((s) => !ran.has(s) && (s !== "sometimes" || model.sometimes.length));
    if (notRun.length && said.some((r) => !r.ok)) skip(`${notRun.join(" and ")} of ${spec.file}`, "simulation stopped at the failure above");
  }
  mirrorGen(root, specs);
  const dirs = codeDirs(root);
  /** A result about an owner's code names its package; the root's own reads as it always has. */
  const within = (dir: string, [ok, stage, summary, detail, where]: Reported): Reported =>
    dir ? [ok, stage, `${dir.slice(0, -1)}: ${summary}`, detail, dir.slice(0, -1)] : [ok, stage, summary, detail, where];

  if (!allOk) skip("types, proof, tests and traces", "a stage above failed, and their failures would only restate it");
  if (allOk) {
    let proofsRan = false;
    /** The proof stage, run while the typecheck does; what it would report, in order. */
    async function provingAll(): Promise<Parameters<typeof report>[]> {
      const out: Parameters<typeof report>[] = [];
      const said = (...args: Parameters<typeof report>) => { out.push(args); };
      try {
        const dafnyProblem = (await dafnyVersion()).problem;
        if (dafnyProblem) throw new Error(dafnyProblem);
        const accepted = readLedger(root);
        const ledger: Record<string, Accepted> = {};
        let recordable = true;
        fs.rmSync(path.join(root, "gen/proof"), { recursive: true, force: true });
        const units = proofUnits(root, [...models.values()], srcFiles);
        for (const f of strayProofFiles(root, units))
          said(false, "proof", `${f} belongs to no proof unit: spec/<name>.proof.dfy belongs to spec/<name>.md, and src/<path>.proof.dfy to src/<path>.ts if that file contains //@`, "", f);
        const lib = fs.readFileSync(LIB_FILE, "utf8");
        const proved = new Map<string, Proof>();
        // Units are proved at the same time and reported in order. One with a proof file is offered every `_ensures`
        // lemma of the units it imports, and keeps that result only if each of those units proved them all in this run;
        // otherwise it is proved again with the clauses they did prove.
        const running = new Map<string, Promise<Proof>>();
        const proofTexts = new Map<string, string | undefined>();
        for (const u of units) {
          const proofPath = located(root, u.proofFile);
          const proofText = fs.existsSync(proofPath) ? fs.readFileSync(proofPath, "utf8") : undefined;
          proofTexts.set(u.unit, proofText);
          const proving = (axioms: Offered[]) => remembered(memory, entry(root, "prove", [u.unit, u.meaning, proofText ?? "", proofText === undefined ? "" : lib, JSON.stringify(axioms)]),
            () => prove(root, u, { proof: proofText === undefined ? undefined : { file: u.proofFile, text: proofText }, lib, axioms }), (p) => !p.errors.length);
          running.set(u.unit, (async () => {
            const offered = proofText === undefined ? [] : u.imports.lemmas.map(({ fn }) => ({ fn }));
            const first = proving(offered);
            await Promise.allSettled([first, ...(offered.length ? u.imports.lemmas.map((l) => running.get(l.from)) : [])]);
            // A clause of an imported lemma is offered only if its own unit proved it, in this run; none of them is if
            // one of the lemma's failures is not one of its clauses. A lemma its unit does not generate has none.
            const resolved = offered.length ? u.imports.lemmas.map(({ fn, def, from }) => {
              const p = proved.get(from);
              if (!p || p.errors.length) return undefined;
              const clauses = ensuresOf(p.dfy, `${def}_ensures`).map((c) => `${def}: ${c}`);
              const failed = p.unproved.filter((x) => x.startsWith(`${def}: `));
              const known = failed.every((x) => clauses.includes(x));
              return { fn, proved: clauses.map((c) => known && !failed.includes(c)) };
            }) : [];
            const proof = resolved.every((r) => r?.proved.every(Boolean)) ? await first
              : await proving(resolved.filter((r): r is Required<Offered> => !!r?.proved.length));
            proved.set(u.unit, proof);
            return proof;
          })());
        }
        // Every unit finishes, whatever another one does, before anything is reported.
        await allDone(units.map((u) => running.get(u.unit)!));
        for (const u of units) {
          const proofText = proofTexts.get(u.unit);
          const proof = proved.get(u.unit)!;
          const { log: logFile, dfy } = proofPaths(u.unit);
          // The final Dafny stays on disk even when the result was remembered, so that it can be read.
          const dfyFile = path.join(root, dfy);
          fs.mkdirSync(path.dirname(dfyFile), { recursive: true });
          fs.writeFileSync(path.join(root, logFile), proof.log);
          if (proof.dfy && !fs.existsSync(dfyFile)) fs.writeFileSync(dfyFile, proof.dfy);
          // What was accepted is tied to the text it was accepted for.
          const meaning = sha(u.text, proofText ?? "").slice(0, 12);
          const was = accepted[u.unit];
          const valid = !u.src && was?.text === meaning ? was.unproved : [];
          const outdated = was && was.text !== meaning ? `; the ${was.unproved.length} accepted earlier were accepted for another text of this unit or its proof file, and no longer count` : "";
          const fresh = proof.unproved.filter((x) => !valid.includes(x));
          const stale = valid.filter((x) => !proof.unproved.includes(x));
          if (!u.src && proof.unproved.length) ledger[u.unit] = { text: meaning, unproved: proof.unproved };
          const listed = (xs: string[]) => indent(xs.map((x) => x + (proof.exhausted.includes(x) ? "   [the prover ran out of resources]" : "") + (proof.resting[x] ? `   [rests on ${proof.resting[x]}]` : "")).join("\n"));
          // Hand-written code proved against a module that is only partly proved rests on what is not.
          const assumed = u.rests.flatMap((r) => (proved.get(r)?.unproved.length ? [`${proved.get(r)!.unproved.length} of ${r}`] : []));
          const assuming = (assumed.length ? `, assuming the obligations that are simulated only (${assumed.join(", ")})` : "")
            // A precondition is assumed by the proof and checked by no one: callers outside verified code must meet it.
            + (u.requires ? `, under ${u.requires} //@ requires that its unverified callers must meet` : "");
          if (proof.errors.length) {
            recordable = false;
            said(false, "proof", `${u.unit}: Dafny could not check it (full output in ${logFile}, final Dafny in ${dfy})`, indent(proof.errors.join("\n")), u.unit);
          } else if (u.src && proof.unproved.length) {
            recordable = false;
            said(false, "proof", `${u.unit}: ${proof.unproved.length} of ${proof.total} obligations not proved. Hand-written code is not simulated, so they must be proved in ${u.proofFile}. Full output in ${logFile}, final Dafny in ${dfy}`, listed(proof.unproved), u.unit);
          } else if (fresh.length && accept !== "unproved") {
            said(false, "proof", `${u.unit}: ${fresh.length} of ${proof.total} obligations not proved${outdated}. Prove them in ${u.proofFile}, or add the rule that makes them provable; if simulation is enough for them, that is the user's decision (\`pnpm accept unproved\`). Full output in ${logFile}, final Dafny in ${dfy}`, listed(fresh), u.unit);
          } else {
            said(true, "proof", `${u.unit}: ${proof.unproved.length ? `${proof.total} obligations, of which ${proof.unproved.length} are simulated only (accepted) and the rest proved` : `all ${proof.total} obligations proved`} for all states and inputs${assuming}`
              + (stale.length && accept !== "unproved" ? `; ${stale.length} accepted earlier now prove, run \`pnpm accept unproved\` to tighten the ledger` : ""), [
                ...(proof.unproved.length ? [`    simulated only, accepted in spec/lock.json:\n${listed(proof.unproved)}`] : []),
                ...(assumed.length ? [`    assumed from the module it is proved against, simulated only there:\n${indent(u.rests.flatMap((name) => (proved.get(name)?.unproved ?? []).map((clause) => `${name}: ${clause}`)).join("\n"))}`] : []),
              ].join("\n"), u.unit, true);
          }
        }
        if (accept === "unproved" && recordable) pendingLedger = { ledger, accepted };
        proofsRan = true;
      } catch (e) {
        said(false, "proof", (e as Error).message);
      }
      return out;
    }
    // The typecheck runs while the proofs do; it is reported first.
    // VibeLang's compiler checks `.vibe`, `.ts` and `.tsx` as one program.
    // Each of the root and the owners is a program of its own, checked against its own gen/.
    const typechecks = dirs.map(async (dir) => fs.existsSync(path.join(root, dir, "tsconfig.json")) ? run("vibelang", ["--noEmit", "-p", "."], path.join(root, dir)) : undefined);
    const proofsDone = provingAll();
    // A missing or unexecutable compiler must not release the project lock while proofs still write into gen/.
    const typesResults = await Promise.allSettled(typechecks);
    if (typesResults.some((r) => r.status === "rejected" || r.value) && !nodeRunsVibelang()) report(false, "types", `VibeLang runs its sources on Node ^22.22.3 or >=24.11.1, and this is ${process.version}; update Node (.nvmrc names the version)`);
    for (const [i, dir] of dirs.entries()) {
      const result = typesResults[i];
      const types = (ok: boolean, summary: string, detail = "") => report(...within(dir, [ok, "types", summary, detail, "src/ and test/"]));
      if (result.status === "rejected") types(false, "the VibeLang compiler could not run", indent(String(result.reason)));
      else if (result.value) types(result.value.ok, result.value.ok ? "application typechecks against the generated contract" : "application does not fit the generated contract", indent(result.value.out.trim()));
      else {
        const code = ["src", "test"].filter((d) => fs.existsSync(path.join(root, dir, d)));
        types(!code.length, code.length ? `${code.join(" and ")} exist but there is no tsconfig.json, so nothing checks them against the generated contract; run \`spec init\` to add one` : "skipped: there is no tsconfig.json and no src/ or test/");
      }
    }
    for (const r of await proofsDone) report(...r);
    for (const dir of dirs) for (const r of await tests(root, dir, specs, (key, ran, keep) => remembered(memory, entry(root, "tests", [dir, key]), ran, keep), mode, memory.fresh)) report(...within(dir, r));
    for (const dir of dirs) for (const r of await conformance(path.join(root, dir), machines, packageScripts(path.join(root, dir)), mode)) report(...within(dir, r));
    if (proofsRan) collectGarbage(memory);
  }
  fs.rmSync(loaded, { recursive: true, force: true });

  // A spec that is not a valid model has nothing to reconcile yet. Everything is recorded at once, or nothing is.
  const locks = new Map<string, Lock>();
  const todos = valid.filter((spec) => !isStd(spec.file)).map((spec) => ({ spec, todo: pending(root, spec, specs, locks) }));
  const contractsToDo = pendingContracts(root, srcFiles);
  const removedSpecs = pendingSpecs(root, specs);
  if (accept) {
    try {
      if (JSON.stringify(readSpecs(root)) !== JSON.stringify(specs) || JSON.stringify(readSrc(root)) !== JSON.stringify(srcFiles)
        || JSON.stringify(proofInputs()) !== JSON.stringify(proofsRead))
        report(false, "review", "sources changed while the check ran; nothing was accepted", "      Run `pnpm check` again on the files now on disk.");
    } catch (e) {
      report(false, "review", "sources changed while the check ran; nothing was accepted", indent((e as Error).message));
    }
  }
  if (accept === "unproved" && allOk && pendingLedger) {
    const { ledger, accepted } = pendingLedger;
    writeLedger(root, ledger);
    const entries = (l: Record<string, Accepted | undefined>) => Object.entries(l).flatMap(([unit, a]) => (a?.unproved ?? []).map((x) => `${unit}: ${x}  [${a!.text}]`));
    const [before, after] = [entries(accepted), entries(ledger)];
    const added = after.filter((x) => !before.includes(x));
    const removed = before.filter((x) => !after.includes(x));
    const line = (sign: string) => (x: string) => `    ${sign} ${x.replace(/  \[[^\]]*\]$/, "")}`;
    report(true, "proof", `${path.relative(root, ledgerFile(root))}: ${added.length} added, ${removed.length} removed`,
      [...added.map(line("+")), ...removed.map(line("-"))].join("\n"), undefined, true);
  }
  const formal = todos.every(({ todo }) => !todo.some((t) => t.status === "story has no rules" || t.status === "not formalized"));
  const record = accept === "reviews" && allOk && formal;
  if (record) acceptAllReviews(root, specs, srcFiles);
  const why = accept !== "reviews" ? "then run `pnpm accept`" : !allOk ? "nothing was accepted: fix the stages above first" : "every story needs rules and every rule a quint block before anything can be accepted";
  const items = (todo: Pending[], heading: string) => {
    const shown = moved(todo);
    return todo.map((t) => "    " + showPending(t)).join("\n") + (shown.length ? `\n\n    ${heading}:\n${shown.join("\n")}` : "");
  };
  for (const { spec, todo } of todos) {
    if (record && todo.length) {
      report(true, "review", `${spec.file}: recorded as reconciled: ${todo.map(pendingKey).join("; ")}`, "", spec.file);
    } else report(!todo.length, "review", todo.length ? `${spec.file}: ${todo.length} item(s) to reconcile, ${why}` : `${spec.file}: prose and model reconciled for all ${spec.rules.length} rules and ${spec.stories.length} stories`,
      items(todo, "What moved, in full"), spec.file);
  }
  if (removedSpecs.length) report(record, "review", record ? "removed specs recorded as reconciled" : `${removedSpecs.length} removed spec(s) to reconcile, ${why}`,
    removedSpecs.map((p) => "    " + showPending(p)).join("\n"));
  // Contracts are reviewed package by package; one whose package is gone is still listed, under where it was.
  const proved = [...contracts(root, srcFiles).keys()];
  for (const dir of new Set([...dirs, ...contractsToDo.map((t) => codeDirOf(t.where))])) {
    const src = `${dir}src/`;
    const todo = contractsToDo.filter((t) => codeDirOf(t.where) === dir);
    const all = proved.filter((file) => codeDirOf(file) === dir).length;
    if (record && todo.length) report(true, "review", `${src}: recorded as reconciled: ${todo.map((t) => t.where).join("; ")}`, "", src);
    else if (todo.length) report(false, "review", `${src}: ${todo.length} contract(s) to reconcile, ${why}`, items(todo, "The contracts, in full"), src);
    else if (all) report(true, "review", `${src}: the //@ contracts of all ${all} proved files reconciled`, "", src);
  }
  return allOk;
}

// --- init ----------------------------------------------------------------------------

/** What a VibeLang shell runs on, and what builds and tests it; `init` adds them at the versions in this package's manifest. */
const VIBELANG = {
  dependencies: ["effect", "@effect/platform-node", "vibelang-runtime"],
  devDependencies: ["vibelang", "vibelang-vite", "vite", "vitest", "@effect/vitest", "@types/node"],
};

/** Set up a project, preserving its content outside the marked Vibestack instructions. */
export function init(root: string, warn: (message: string) => void = (message) => console.warn(`note: ${message}`)): string[] {
  const pkg = path.join(import.meta.dirname, "..");
  const done: string[] = [];
  const add = (file: string, content: () => string) => {
    if (fs.lstatSync(path.join(root, file), { throwIfNoEntry: false })) return;
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content());
    done.push(file);
  };
  for (const name of ["sync", "design", "shell", "prove"]) {
    const source = `.claude/skills/${name}`;
    add(`${source}/SKILL.md`, () => fs.readFileSync(path.join(pkg, source, "SKILL.md"), "utf8"));
    const link = path.join(root, `.agents/skills/${name}`);
    if (!fs.lstatSync(link, { throwIfNoEntry: false })) {
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(path.relative(path.dirname(link), path.join(root, source)), link, "dir");
      done.push(`.agents/skills/${name}`);
    }
  }
  // AGENTS.md links to it.
  add("SPEC.md", () => fs.readFileSync(path.join(pkg, "SPEC.md"), "utf8"));
  const agents = path.join(root, "AGENTS.md");
  const procedure = fs.readFileSync(path.join(pkg, "AGENTS.md"), "utf8").trim();
  const previous = fs.existsSync(agents) ? fs.readFileSync(agents, "utf8") : "";
  const eol = previous.includes("\r\n") ? "\r\n" : "\n";
  const section = `<!-- vibestack:start -->${eol}${procedure.replace(/\r?\n/g, eol)}${eol}<!-- vibestack:end -->`;
  const starts = [...previous.matchAll(/<!-- (vibestack|vibespec|onespec):start\b[^>]*-->/g)];
  const ends = [...previous.matchAll(/<!-- (vibestack|vibespec|onespec):end -->/g)];
  if (starts.length !== ends.length || starts.length > 1 || (starts.length === 1 && (starts[0][1] !== ends[0][1] || starts[0].index! > ends[0].index!)))
    throw new Error("AGENTS.md: repair the duplicated or incomplete Vibestack markers before running spec init");
  const updated = starts.length ? previous.slice(0, starts[0].index) + section + previous.slice(ends[0].index! + ends[0][0].length)
    : previous.trim() === procedure ? `${section}${eol}`
    : `${previous.trimEnd()}${previous.trim() ? eol + eol : ""}${section}${eol}`;
  if (updated !== previous) {
    fs.writeFileSync(agents, updated);
    done.push("AGENTS.md (Vibestack instructions)");
  }
  const claude = path.join(root, "CLAUDE.md");
  const own = fs.existsSync(claude) ? fs.readFileSync(claude, "utf8") : "";
  if (!/^@AGENTS\.md\s*$/m.test(own)) {
    const eol = own.includes("\r\n") ? "\r\n" : "\n";
    fs.writeFileSync(claude, `${own.trimEnd()}${own.trim() ? eol + eol : ""}@AGENTS.md${eol}`);
    done.push("CLAUDE.md (imports AGENTS.md)");
  }
  add("tsconfig.json", () => JSON.stringify({
    compilerOptions: { target: "es2023", module: "nodenext", strict: true, skipLibCheck: true, types: ["node"], rootDir: ".", rootDirs: [".", ".vibe/declarations"], outDir: "dist", noEmitOnError: true, rewriteRelativeImportExtensions: true },
    include: ["src", "test", "gen/*.ts", "gen/*.vibe"], vibe: { sidecarDir: ".vibe/declarations" },
  }, null, 2) + "\n");
  add("vitest.config.ts", () => VITEST_CONFIG);
  add("spec/index.md", () => "");
  const ignore = path.join(root, ".gitignore");
  const ignored = fs.existsSync(ignore) ? fs.readFileSync(ignore, "utf8") : "";
  const missing = ["gen/", ".spec-cache/", ".studio/", "dist/", ".vibe/"].filter((l) => !ignored.split("\n").includes(l));
  if (missing.length) { fs.writeFileSync(ignore, ignored + (ignored && !ignored.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n"); done.push(".gitignore"); }
  const manifest = path.join(root, "package.json");
  if (fs.existsSync(manifest)) {
    const json = JSON.parse(fs.readFileSync(manifest, "utf8"));
    const scripts = { dev: "spec studio", check: "spec check", gen: "spec gen", accept: "spec accept", build: "vibelang", test: "vitest run" };
    const added = Object.entries(scripts).filter(([name]) => !json.scripts?.[name] || (name === "test" && /no test specified/.test(json.scripts.test)));
    if (added.length) json.scripts = { ...json.scripts, ...Object.fromEntries(added) };
    // The VibeLang toolchain at the versions these tools are tested with: its packages move together, and with one Effect.
    const own = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8"));
    const pins: Record<string, string> = { ...own.dependencies, ...own.devDependencies };
    const has = { ...json.dependencies, ...json.devDependencies };
    const lacking = (names: string[]) => Object.fromEntries(names.filter((n) => !(n in has)).map((n) => [n, pins[n]]));
    const [runtime, tooling] = [lacking(VIBELANG.dependencies), lacking(VIBELANG.devDependencies)];
    const needs = Object.keys({ ...runtime, ...tooling });
    if (needs.length) {
      json.dependencies = { ...json.dependencies, ...runtime };
      json.devDependencies = { ...json.devDependencies, ...tooling };
      // Effect's packages share one version; a transitive copy at another is refused when the runtime loads.
      json.pnpm = { ...json.pnpm, overrides: { "@effect/platform-node-shared": pins["@effect/platform-node"], ...json.pnpm?.overrides } };
    }
    // AGENTS.md, "The stack"
    const managed = json.packageManager === undefined;
    if (managed) json.packageManager = "pnpm@10.24.0";
    const runtimeDefault = json.engines?.node === undefined;
    if (runtimeDefault) json.engines = { ...json.engines, node: ">=26" };
    const typed = json.type === undefined;
    if (typed) json.type = "module";
    else if (json.type !== "module") warn(`package.json: "type" is ${JSON.stringify(json.type)}, so Node runs src/ and test/ as CommonJS, where an import statement fails; set "type": "module" if those files use ES imports (gen/ has its own package.json)`);
    if (added.length || typed || needs.length || managed || runtimeDefault) {
      fs.writeFileSync(manifest, JSON.stringify(json, null, 2) + "\n");
      if (added.length) done.push(`package.json scripts: ${added.map(([n]) => n).join(", ")}`);
      if (needs.length) done.push(`package.json VibeLang toolchain: ${needs.join(", ")} (run your package manager's install)`);
      if (managed) done.push("package.json packageManager: pnpm@10.24.0");
      if (runtimeDefault) done.push("package.json engines.node: >=26");
      if (typed) done.push('package.json "type": "module"');
    }
  }
  return done;
}


// --- new -----------------------------------------------------------------------------

/** A spec that passes every check as it is: one story, the state, one guarded transition, an `always` and a `sometimes` rule. */
const starter = (name: string, fence = "`".repeat(3)) => `# ${name}

What the application is for, in a sentence or two. Replace the story and its
rules with your own; SPEC.md says how to write them.

## Story: Keep a tally

> As a user, I want to add to a tally, never past its limit, so that I can
> count things up to a known number.

### A new tally is empty

${fence}quint
type Tally = { count: int }
pure val initial: Tally = { count: 0 }
${fence}

### Only a positive amount that keeps the tally within its limit can be added

The limit is ten, and the tally never passes it.

${fence}quint
pure val limit = 10
pure def canAdd(t: Tally, n: int): bool = n > 0 and t.count + n <= limit
pure def add(t: Tally, n: int): Tally = { count: t.count + n }
pure def alwaysWithinLimit(t: Tally): bool = 0 <= t.count and t.count <= limit
${fence}

### A tally can reach its limit

${fence}quint
pure def sometimesFull(t: Tally): bool = t.count == limit
${fence}
`;

/** Write a directory's index without replacing an existing specification. */
export function newSpec(root: string, name = ""): string {
  const parts = name === "index" || !name ? [] : name.split("/");
  for (const part of parts) {
    const bad = badSpecName(part);
    if (bad) throw new Error(`spec new ${name}: ${bad}`);
  }
  const file = ["spec", ...parts, "index.md"].join("/");
  const collision = specFiles(root).find((existing) => existing !== file && specName(existing) === specName(file));
  if (collision) throw new Error(`${file} and ${collision} would have the same module name; nothing was written`);
  let directory = root;
  for (const part of ["spec", ...parts]) {
    directory = path.join(directory, part);
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error(`${file}: spec directories may not be symlinks`);
    fs.mkdirSync(directory, { recursive: true });
  }
  const target = path.join(root, file);
  if (fs.existsSync(target)) {
    if (fs.lstatSync(target).isSymbolicLink() || parts.length || fs.readFileSync(target, "utf8") !== "")
      throw new Error(`${file} already exists; nothing was written`);
    fs.writeFileSync(target, starter("Application"));
  } else fs.writeFileSync(target, starter(parts.at(-1) ?? "Application"), { flag: "wx" });
  return file;
}

// --- CLI -----------------------------------------------------------------------------

/** Older runtimes still reach the CLI's unsupported-Node diagnostic. */
const isMain = (): boolean => {
  if (typeof import.meta.main === "boolean") return import.meta.main;
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

const USAGE = "usage: spec check [<directory>] [--json] [--nightly] | watch [<directory>] | gen [<directory>] [--if-valid] | accept [<directory>] [unproved] | new [<path>] | init [<directory>] | migrate [<directory>] | studio [<directory>] [--port <n>] | tests [<directory>] | stories gen [--watch] [--check] | tokens build|check|apply | tasks [<task>…]";

/**
 * Check, then check again whenever spec/, package.json, tsconfig.json, or src/ or test/ of the root or of an owner changes. One process stays warm between runs
 * (the compiler, the toolchain's fingerprint and the cache are already loaded), edits that arrive during a run start
 * one more run after it, and what is unchanged comes from the cache as in any check.
 */
async function watch(root: string) {
  let running = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const once = async () => {
    if (running) { again = true; return; }
    running = true;
    do {
      again = false;
      const started = Date.now();
      console.log(`\n--- ${new Date().toLocaleTimeString()} ---`);
      attach(); // a package that came to own part of the spec tree is watched from the next run
      try {
        const { next } = await check(root, false, (r) => console.log(show(r)));
        console.log(`\nnext: ${next}\n(${((Date.now() - started) / 1000).toFixed(1)}s; watching spec/, src/ and test/, here and in the packages the spec names, and package.json and tsconfig.json; Ctrl-C to stop)`);
      } catch (e) {
        console.error((e as Error).message);
      }
    } while (again);
    running = false;
  };
  const changed = (file?: string | null) => {
    // Editors write temporary files beside the real one; only sources matter.
    if (file && !/\.(md|tsx?|vibex?|dfy|json)$/.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(once, 200);
  };
  // Watch source directories when they exist, and their parent for creation, replacement and atomic config saves.
  const watched = new Map<string, { watcher: fs.FSWatcher; ino: number }>();
  const inode = (dir: string) => { try { return fs.statSync(path.join(root, dir)).ino; } catch { return undefined; } };
  const attach = () => {
    let areas: string[] = [];
    try { areas = fs.readdirSync(path.join(root, "spec"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { /* the root watcher observes a replacement spec directory */ }
    const packages = ["apps", "packages"].flatMap((dir) => [dir, ...areas.map((area) => `${dir}/${area}`)]);
    const dirs = new Map([["spec", true], ...packages.map((dir): [string, boolean] => [dir, false]),
      ...codeDirs(root).flatMap((dir): [string, boolean][] => [[dir || ".", false], [`${dir}src`, true], [`${dir}test`, true]])]);
    for (const dir of new Set([...dirs.keys(), ...watched.keys()])) {
      const ino = dirs.has(dir) ? inode(dir) : undefined;
      const had = watched.get(dir);
      if (had && had.ino === ino) continue;
      if (had) { had.watcher.close(); watched.delete(dir); }
      if (ino === undefined) continue;
      try {
        const watcher = fs.watch(path.join(root, dir), { recursive: dirs.get(dir) }, (_, file) => {
          if (dirs.get(dir)) changed(file);
          else if (dir === "apps" || dir === "packages") {
            const child = file && `${dir}/${file}`;
            if (child && inode(child) !== watched.get(child)?.ino) { attach(); changed(); }
          } else if (file === "apps" || file === "packages" || file === "spec" || file === "src" || file === "test") { attach(); changed(); }
          else if (file === "package.json" || file === "tsconfig.json") changed(file);
        });
        watcher.on("error", () => { watcher.close(); if (watched.get(dir)?.watcher === watcher) watched.delete(dir); });
        watched.set(dir, { watcher, ino });
      } catch { /* the directory was removed while attaching; its next parent event retries */ }
    }
  };
  attach();
  await once();
}

if (isMain()) {
  let root = process.cwd();
  const [command, ...args] = process.argv.slice(2);
  const takes = (...allowed: string[][]) => allowed.some((a) => a.length === args.length && a.every((x, i) => x === "*" || x === args[i]));
  try {
    if (Number(process.versions.node.split(".")[0]) < 26) throw new Error(`spec needs Node 26 or later; this is Node ${process.versions.node}`);
    const options: Record<string, string[]> = { check: ["--json", "--nightly"], gen: ["--if-valid"], accept: ["unproved"], watch: [], init: [], migrate: [] };
    if (Object.hasOwn(options, command)) {
      const directories = args.filter((arg) => !options[command].includes(arg));
      if (directories.length === 1 && !directories[0].startsWith("-")) {
        root = projectRoot(directories[0]);
        args.splice(args.indexOf(directories[0]), 1);
      }
    }
    if (command === "tasks") {
      const fingerprint = path.join(root, ".cache", "toolchain.json");
      const text = JSON.stringify(await toolchainFingerprint()) + "\n";
      fs.mkdirSync(path.dirname(fingerprint), { recursive: true });
      if (!fs.existsSync(fingerprint) || fs.readFileSync(fingerprint, "utf8") !== text) fs.writeFileSync(fingerprint, text);
      let env: NodeJS.ProcessEnv = { ...process.env, TURBO_TELEMETRY_DISABLED: "1" };
      const credentials = path.join(os.homedir(), ".config", "vibestack", "turbo-cache.json");
      if (env.TURBO_TOKEN === undefined && fs.existsSync(credentials)) {
        const cache = JSON.parse(fs.readFileSync(credentials, "utf8"));
        const declared = JSON.parse(fs.readFileSync(path.join(root, "turbo.json"), "utf8")).remoteCache?.apiUrl;
        env = cacheCredentials(env, args, declared, cache);
      }
      const child = spawn(bin("turbo", root), ["run", ...args], { cwd: root, env, stdio: "inherit" });
      child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
    } else if (command === "gen" && takes([], ["--if-valid"])) {
      // --if-valid is for `pnpm install`: a spec in the middle of an edit must not make installing fail.
      const release = lockProject(root);
      try {
        const specs = readSpecs(root);
        const typed = typecheckAll({ root, fresh: false, used: new Set() }, specs);
        const inputs = await allDone(specs.map((s) => typed.get(s.name)!));
        fs.rmSync(path.join(root, "gen"), { recursive: true, force: true });
        fs.mkdirSync(path.join(root, "gen"), { recursive: true });
        const models = new Map<string, Model>();
        for (const [i, s] of specs.entries()) {
          fs.writeFileSync(path.join(root, "gen", `${s.name}.qnt`), s.qnt);
          generated(root, s, inputs[i], models);
        }
        mirrorGen(root, specs);
      } catch (e) {
        if (!args.length) throw e;
        console.log(`note: gen/ was not generated, because a spec is not valid yet (${(e as Error).message.split("\n")[0]}); \`pnpm check\` says why`);
      } finally {
        release();
      }
    } else if ((command === "check" && takes([], ["--json"], ["--nightly"], ["--json", "--nightly"], ["--nightly", "--json"])) || (command === "accept" && takes([], ["unproved"]))) {
      const json = args.includes("--json");
      const accept = command === "check" ? false : args[0] === "unproved" ? "unproved" : "reviews";
      const { ok, results, next } = await check(root, accept, json ? undefined : (r) => console.log(show(r)), args.includes("--nightly") ? "nightly" : "normal");
      console.log(json ? JSON.stringify({ ok, results, next }, null, 2) : `\nnext: ${next}`);
      process.exitCode = ok ? 0 : 1;
    } else if (command === "init" && takes([])) {
      const done = init(root);
      console.log(done.length ? `added: ${done.join(", ")}` : "nothing to add: everything is already there");
    } else if (command === "watch" && takes([])) {
      await watch(root);
    } else if (command === "studio" && takes([], ["*"], ["--port", "*"], ["*", "--port", "*"])) {
      // Studio is VibeLang: built, its entry is JavaScript; from source, Node loads it through VibeLang's loader.
      const built = import.meta.filename.endsWith(".js");
      const entry = path.join(import.meta.dirname, "studio/src", built ? "main.js" : "main.vibe");
      const loader = built ? [] : ["--import", pathToFileURL(createRequire(path.join(import.meta.dirname, "studio/package.json")).resolve("vibelang/register")).href];
      const child = spawn(process.execPath, [...loader, entry, ...args], { cwd: root, stdio: "inherit" });
      child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
    } else if (command === "stories" || command === "tokens") {
      // Each is a command line of its own, reading its arguments after its name (stories/cli.ts, design/cli.ts).
      process.argv.splice(2, 1);
      await (command === "stories" ? import("./stories/cli.ts") : import("./design/cli.ts"));
    } else if (command === "tests" && takes([], ["*"])) {
      await (await import("./testing/generate.ts")).main(args[0]);
    } else if (command === "migrate" && takes([])) {
      const release = lockProject(root);
      try {
        const files = migrateLocks(root);
        console.log(files.length ? `migrated ${files.length} ledgers to spec/lock.json; reviews preserved, and proof exceptions in the old list form, if any, dropped: prove them or run \`pnpm accept unproved\` again` : "no legacy ledgers to migrate");
      } finally { release(); }
    } else if (command === "new" && takes([], ["*"])) {
      console.log(`wrote ${newSpec(root, args[0])}; run \`pnpm check\``);
    } else {
      console.error(USAGE);
      process.exitCode = 2;
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
