#!/usr/bin/env node
// The spec pipeline and command line. Parsing, review, generation, simulation and proof each have one implementation.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Model } from "./gen.ts";
import { conformance, type Machine } from "./conform.ts";
import { explore } from "./explore.ts";
import { ensuresOf, LIB_FILE, libraryFor, proofPaths, prove, type Offered, type Proof } from "./prove.ts";
import { bin, run } from "./run.ts";
import { readSpecs, badSpecName, specFiles, specName, isStd, located, type Spec } from "./parse.ts";
import { contracts, pending, pendingKey, pendingContracts, acceptAllReviews, pendingSpecs, moved, showPending, ledgerFile, readReviewLock, writeLedger, type Pending, type Accepted, type ReviewLock } from "./review.ts";
import { cacheCredentials, dafnyVersion, entry, recall, remembered, store, collectGarbage, toolchainFingerprint, type Memory } from "./cache.ts";
import { generated, mirrorGen, typecheckAll, proofUnits, proofFiles, strayProofFiles } from "./units.ts";
import { simulation, type Simulation } from "./simulate.ts";
import { sha, digest, indent, packageScripts, pruneSidecars, configured, testInputs, tests, VITEST_CONFIG, readSrc, codeDirs, codeDirOf, projectRoot, allDone, type Reported, type SrcFile } from "./util.ts";
import { profile, type TestProfile } from "./testing/profile.ts";
import { availableDirectory, generatedSkillIgnores, linkProjectSkills, skillRoot } from "./skill-links.ts";

export { readSpecs, parseSpec, expandListHelpers, type Spec, type Rule, type Story } from "./parse.ts";
export { pending, pendingKey, pendingContracts, acceptReviews, acceptContracts, dependencies, type Lock, type Pending } from "./review.ts";
export { generated, typecheckAll, checkVerifiedSource } from "./units.ts";
export { replay, type Step } from "./simulate.ts";
export { danglingCitations } from "./util.ts";
export { scanSpec } from "./scan.ts";

export interface Result { ok: boolean; stage: "model" | "always" | "sometimes" | "replay" | "types" | "proof" | "tests" | "traces" | "explore" | "review" | "skipped"; summary: string; detail: string; where?: string; /** The rules the result concerns, each by its spec and key. */ rules?: { file: string; key: string }[] }
/** The Node these tools run on: the major release .nvmrc pins, and the root's `engines` floor. */
export const NODE = 26;
export const show = ({ ok, stage, summary, detail }: Result) => `${stage === "skipped" ? "-" : ok ? "✓" : "✗"} ${stage.padEnd(9)} ${summary}${detail ? "\n" + detail.trimEnd() : ""}`;

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
      explore: "fix the page where it breaks the property, or test/bombadil.ts if the property no longer says what the rules ask",
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

/** Take the project's lock for one check, accept or gen at a time; returns what releases it. A lock left by a process that has ended is taken over. */
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
  const holderOf = (lock: string) => { try { return parseInt(fs.readFileSync(lock, "utf8"), 10); } catch { return NaN; /* removed in the meantime */ } };
  const refuse = (holder: number): never => { throw new Error(`another check or accept is running in this project (process ${holder}); wait for it to finish. If no such process is running, delete ${path.relative(root, file)}`); };
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(file, `${process.pid}\n`, { flag: "wx" });
      return () => fs.rmSync(file, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const holder = holderOf(file);
    if (alive(holder) || attempt) refuse(holder);
    // A rename moves the stale lock away for one process only. One that moved the lock of a process that had just
    // taken over instead puts it back.
    const stale = `${file}.${process.pid}.stale`;
    try { fs.renameSync(file, stale); } catch { continue; }
    const moved = holderOf(stale);
    if (alive(moved)) {
      try { fs.linkSync(stale, file); } catch { /* taken again in the meantime */ }
      fs.rmSync(stale, { force: true });
      refuse(moved);
    }
    fs.rmSync(stale, { force: true });
  }
}

/**
 * Each spec's module written to gen/: its model as it is generated, or why it has none. The owners' gen/ follows once
 * every module is written (units.ts, `mirrorGen`).
 */
async function* generating(memory: Memory, specs: Spec[]): AsyncGenerator<{ spec: Spec; model: Model; error?: undefined } | { spec: Spec; model?: undefined; error: Error }> {
  const models = new Map<string, Model>();
  const typed = typecheckAll(memory, specs);
  try {
    for (const spec of specs) {
      const missing = spec.imports.find((i) => !models.has(i));
      yield missing ? { spec, error: new Error(`it imports ${missing}, which is not a valid model`) }
        : await typed.get(spec.name)!.then((ir) => ({ spec, model: generated(memory.root, spec, ir, models) })).catch((error: Error) => ({ spec, error }));
    }
  } finally {
    // A caller that stops early must not restore gen/ while a typecheck still writes into it.
    await Promise.allSettled(typed.values());
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
export async function check(root: string, accept: false | "reviews" | "unproved" = false, log: (result: Result) => void = () => {}, mode: TestProfile = "normal"): Promise<{ ok: boolean; results: Result[]; next: string; wrote: Map<string, string> }> {
  // The tests stage names the project that is checking: checking it again from its tests, or from an owner's, which are
  // below it, would wait on its lock or rewrite the gen/ those tests read.
  const fromTests = process.env.SPEC_TESTS ? path.relative(process.env.SPEC_TESTS, fs.realpathSync(root)) : undefined;
  if (fromTests !== undefined && fromTests.split(path.sep)[0] !== ".." && !path.isAbsolute(fromTests)) throw new Error("a test script cannot run spec check or accept: the check already runs the tests");
  const release = lockProject(root);
  // Node caches imported modules by path, so each run loads its generated code from a directory of its own.
  const loaded = path.join(root, "gen", `run-${Date.now()}`);
  try {
    const results: Result[] = [];
    const wrote = new Map<string, string>();
    await checkLocked(root, accept, loaded, (r) => { results.push(r); log(r); }, mode, wrote);
    return { ok: results.every((r) => r.ok), results, next: nextStep(results), wrote };
  } finally {
    fs.rmSync(loaded, { recursive: true, force: true });
    release();
  }
}

/**
 * The proof stage, run while the typecheck does: what it reports, in order, and the proposed ledger if it passes.
 */
async function proofStage(root: string, memory: Memory, specs: Spec[], models: Model[], srcFiles: SrcFile[], accepted: Record<string, Accepted | undefined>, accept: false | "reviews" | "unproved"): Promise<{ results: Result[]; ledger?: Record<string, Accepted> }> {
  const results: Result[] = [];
  const said = (ok: boolean, summary: string, detail = "", where?: string, rules: Result["rules"] = []) =>
    results.push({ ok, stage: "proof", summary, detail, ...(where ? { where } : {}), ...(rules.length ? { rules } : {}) });
  try {
    const dafnyProblem = (await dafnyVersion()).problem;
    if (dafnyProblem) throw new Error(dafnyProblem);
    const ledger: Record<string, Accepted> = {};
    fs.rmSync(path.join(root, "gen/proof"), { recursive: true, force: true });
    const units = proofUnits(root, models, srcFiles);
    for (const f of strayProofFiles(root, units))
      said(false, `${f} belongs to no proof unit: spec/<name>.proof.dfy belongs to spec/<name>.md, and src/<path>.proof.dfy to src/<path>.ts if that file contains //@`, "", f);
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
      const proving = (axioms: Offered[]) => remembered(memory, entry(root, "prove", [JSON.stringify({ ...u, text: undefined }), proofText ?? "", proofText === undefined ? "" : libraryFor(lib, proofText) ?? "", JSON.stringify(axioms)]),
        (memory) => prove(memory, u, { proof: proofText === undefined ? undefined : { file: u.proofFile, text: proofText }, lib, axioms }), (p) => !p.errors.length);
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
      const { log: logFile, dfy, scaffold } = proofPaths(u.unit);
      // The final Dafny stays on disk even when the result was remembered, so that it can be read.
      const dfyFile = path.join(root, dfy);
      fs.mkdirSync(path.dirname(dfyFile), { recursive: true });
      fs.writeFileSync(path.join(root, logFile), proof.log);
      if (proof.dfy && !fs.existsSync(dfyFile)) fs.writeFileSync(dfyFile, proof.dfy);
      if (proof.scaffold) fs.writeFileSync(path.join(root, scaffold), proof.scaffold);
      // What was accepted is tied to the Quint and the proof file it was accepted for, as the proof's cache entry is.
      const meaning = sha(u.meaning, proofText ?? "").slice(0, 12);
      const was = accepted[u.unit];
      const valid = !u.src && was?.text === meaning ? was.unproved : [];
      const outdated = was && was.text !== meaning ? `; the ${was.unproved.length} accepted earlier were accepted for another text of this unit or its proof file, and no longer count` : "";
      const fresh = proof.unproved.filter((x) => !valid.includes(x));
      const retained = accept === "unproved" ? proof.unproved : valid.filter((x) => proof.unproved.includes(x));
      if (!u.src && retained.length) ledger[u.unit] = { text: meaning, unproved: retained };
      const start = proof.scaffold ? `\n      their lemmas without a body yet, each with one to start from: ${scaffold}` : "";
      /** The rules the obligations name: the transition or law each is of, and every definition its clause mentions. */
      const named = (xs: string[]) => {
        const spec = specs.find((s) => `${s.name}.ts` === u.unit);
        const words = new Set(xs.join(" ").match(/[A-Za-z_]\w*/g));
        return spec?.rules.filter((r) => r.defs.some((d) => words.has(d))).map((r) => ({ file: spec.file, key: r.key }));
      };
      const listed = (xs: string[]) => indent(xs.map((x) => x + (proof.exhausted.includes(x) ? "   [the prover ran out of resources]" : "") + (proof.resting[x] ? `   [rests on ${proof.resting[x]}]` : "")).join("\n"));
      // Hand-written code proved against a module that is only partly proved rests on what is not.
      const assumed = u.rests.flatMap((r) => (proved.get(r)?.unproved.length ? [`${proved.get(r)!.unproved.length} of ${r}`] : []));
      const assuming = (assumed.length ? `, assuming the obligations that are simulated only (${assumed.join(", ")})` : "")
        // A precondition is assumed by the proof and checked by no one: callers outside verified code must meet it.
        + (u.requires ? `, under ${u.requires} //@ requires that its unverified callers must meet` : "");
      if (proof.errors.length) {
        said(false, `${u.unit}: Dafny could not check it (full output in ${logFile}, final Dafny in ${dfy})`, indent(proof.errors.join("\n")), u.unit);
      } else if (u.src && proof.unproved.length) {
        said(false, `${u.unit}: ${proof.unproved.length} of ${proof.total} obligations not proved. Hand-written code is not simulated, so they must be proved in ${u.proofFile}. Full output in ${logFile}, final Dafny in ${dfy}`, listed(proof.unproved) + start, u.unit);
      } else if (fresh.length && accept !== "unproved") {
        said(false, `${u.unit}: ${fresh.length} of ${proof.total} obligations not proved${outdated}. Prove them in ${u.proofFile}, or add the rule that makes them provable; if simulation is enough for them, that is the user's decision (\`pnpm accept unproved\`). Full output in ${logFile}, final Dafny in ${dfy}`, listed(fresh) + start, u.unit, named(fresh));
      } else {
        said(true, `${u.unit}: ${proof.unproved.length ? `${proof.total} obligations, of which ${proof.unproved.length} are simulated only (accepted) and the rest proved` : `all ${proof.total} obligations proved`} for all states and inputs${assuming}`, [
            ...(proof.unproved.length ? [`    simulated only, accepted in spec/lock.json:\n${listed(proof.unproved)}`] : []),
            ...(assumed.length ? [`    assumed from the module it is proved against, simulated only there:\n${indent(u.rests.flatMap((name) => (proved.get(name)?.unproved ?? []).map((clause) => `${name}: ${clause}`)).join("\n"))}`] : []),
          ].join("\n"), u.unit);
      }
    }
    return { results, ...(results.every((r) => r.ok) ? { ledger } : {}) };
  } catch (e) {
    said(false, (e as Error).message);
    return { results };
  }
}

/**
 * VibeLang's typecheck of one of `codeDirs`, remembered after a pass until what it read changes: the package's inputs
 * but its prose (util.ts, `testInputs`), its tsconfig.json, the configurations it extends and the files they include,
 * and each file outside node_modules that the passing compile read. Installed packages are the lock file's, and the
 * compiler and its library are the stage's toolchain (cache.ts).
 */
async function typecheck(memory: Memory, root: string, dir: string): Promise<{ ok: boolean; out: string }> {
  const at = path.join(root, dir);
  pruneSidecars(at);
  const contents = (files: string[]) => files.map((file): [string, string] => [path.relative(root, file), fs.existsSync(file) ? digest(fs.readFileSync(file, "utf8")) : ""]);
  const kept = await entry(root, "types", [dir, testInputs(at, "normal", "types"), JSON.stringify(contents(configured(at)))]);
  const passed = recall<{ read: [string, string][] }>(memory, kept);
  if (passed && JSON.stringify(contents(passed.read.map(([file]) => path.join(root, file)))) === JSON.stringify(passed.read)) return { ok: true, out: "" };
  const r = await run("vibelang", ["--noEmit", "--listFiles", "-p", "."], at);
  const lines = r.out.split("\n");
  const local = (line: string) => path.isAbsolute(line) && fs.existsSync(line);
  if (r.ok) store(memory, kept, { read: contents(lines.filter((line) => local(line) && !line.split(/[\\/]/).includes("node_modules"))) });
  return { ok: r.ok, out: lines.filter((line) => !line.startsWith("bundled:///") && !local(line)).join("\n") };
}

async function checkLocked(root: string, accept: false | "reviews" | "unproved", loaded: string, log: (result: Result) => void, mode: TestProfile, wrote: Map<string, string>) {
  const { seed } = profile(mode);
  let allOk = true;
  const report = (r: Result) => { allOk &&= r.ok; log(r); };
  const skip = (stages: string, why: string) => report({ ok: true, stage: "skipped", summary: `${stages}: ${why}`, detail: "" });
  /** The cache entries this run uses stay; recent entries of other branches and profiles survive pruning. */
  const memory: Memory = { root, fresh: !!accept || mode === "nightly", used: new Set() };
  let specs: Spec[];
  let srcFiles: SrcFile[];
  const proofInputs = () => proofFiles(root).map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]);
  let proofsRead: string[][];
  let lock: ReviewLock;
  /** The scripts of the root and of each owner, by its prefix (util.ts, `codeDirs`). */
  let scripts: Map<string, Record<string, string>>;
  try {
    srcFiles = readSrc(root);
    proofsRead = proofInputs();
    specs = readSpecs(root);
    lock = readReviewLock(root);
    scripts = new Map(codeDirs(root).map((dir) => [dir, packageScripts(path.join(root, dir))]));
  } catch (e) {
    report({ ok: false, stage: "model", summary: (e as Error).message, detail: "" });
    return;
  }
  const dirs = [...scripts.keys()];
  const valid: Spec[] = [];
  const models: Model[] = [];
  const machines = new Map<string, Machine>();
  /** Each spec's simulation starts once its model is generated; they run at once and are reported in the specs' order. */
  const simulations: { spec: Spec; model: Model; domain: any; simulated: Promise<Simulation> }[] = [];

  // gen/ written anew, so that nothing stale survives a rename.
  fs.rmSync(path.join(root, "gen"), { recursive: true, force: true });
  for await (const { spec, model, error } of generating(memory, specs)) {
    let domain: any;
    try {
      if (!model) throw error;
      models.push(model);
      fs.mkdirSync(loaded, { recursive: true });
      fs.copyFileSync(path.join(root, `gen/${spec.name}.ts`), path.join(loaded, `${spec.name}.ts`));
      domain = await import(pathToFileURL(path.join(loaded, `${spec.name}.ts`)).href);
    } catch (e) {
      report({ ok: false, stage: "model", summary: `${spec.file} is not a valid model`, detail: indent((e as Error).message.trim()), where: spec.file });
      skip(`always, sometimes and replay of ${spec.file}`, "it is not a valid model");
      continue;
    }
    valid.push(spec);
    const parts = [[model.transitions.length, "transitions"], [model.always.length, "always"], [model.steps.length, "step"], [model.leadsTo.length, "leadsTo"], [model.sometimes.length, "sometimes"], [model.laws.length, "laws"], [model.opaques.length, "opaque"]];
    report({ ok: true, stage: "model", summary: `${spec.file}: ${parts.filter(([n]) => n).map((p) => p.join(" ")).join(", ") || "definitions only"}`, detail: "", where: spec.file });
    if (!model.stateType && !model.laws.length && !model.evals.length) continue;
    const simulated = simulation(memory, spec, specs, model, domain, seed);
    simulated.catch(() => {}); // a failure is reported in its turn, not as an unhandled rejection
    simulations.push({ spec, model, domain, simulated });
  }
  // Every simulation finishes before anything is reported, so that none is left writing into gen/.
  await Promise.allSettled(simulations.map((s) => s.simulated));
  for (const { spec, model, domain, simulated } of simulations) {
    const { said, tested } = await simulated;
    if (tested) machines.set(model.name, { domain, model, found: tested });
    said.forEach(report);
    const ran = new Set(said.map((r) => r.stage));
    const notRun = (["sometimes", "replay"] as const).filter((s) => !ran.has(s) && (s !== "sometimes" || model.sometimes.length));
    if (notRun.length && said.some((r) => !r.ok)) skip(`${notRun.join(" and ")} of ${spec.file}`, "simulation stopped at the failure above");
  }
  mirrorGen(root, specs);
  /** A result about an owner's code names its package; the root's own reads as it always has. */
  const within = (dir: string, r: Result): Result => (dir ? { ...r, summary: `${dir.slice(0, -1)}: ${r.summary}`, where: dir.slice(0, -1) } : r);
  const result = ([ok, stage, summary, detail = "", where]: Reported): Result => ({ ok, stage, summary, detail: ok ? "" : detail, ...(where ? { where } : {}) });
  const restates = "a stage above failed, and their failures would only restate it";
  let ledger: Record<string, Accepted> | undefined;

  if (!allOk) skip("types, proof, tests, traces and explore", restates);
  else {
    // The typecheck runs while the proofs do; it is reported first.
    // VibeLang's compiler checks `.vibe`, `.ts` and `.tsx` as one program.
    // Each of the root and the owners is a program of its own, checked against its own gen/.
    const typechecks = dirs.map(async (dir) => fs.existsSync(path.join(root, dir, "tsconfig.json")) ? typecheck(memory, root, dir) : undefined);
    const proving = proofStage(root, memory, specs, models, srcFiles, lock.unproved, accept);
    // A missing or unexecutable compiler must not release the project lock while proofs still write into gen/.
    const typesResults = await Promise.allSettled(typechecks);
    for (const [i, dir] of dirs.entries()) {
      const result = typesResults[i];
      const types = (ok: boolean, summary: string, detail = "") => report(within(dir, { ok, stage: "types", summary, detail: ok ? "" : detail, where: "src/ and test/" }));
      if (result.status === "rejected") types(false, "the VibeLang compiler could not run", indent(String(result.reason)));
      else if (result.value) types(result.value.ok, result.value.ok ? "application typechecks against the generated contract" : "application does not fit the generated contract", indent(result.value.out.trim()));
      else {
        const code = ["src", "test"].filter((d) => fs.existsSync(path.join(root, dir, d)));
        types(!code.length, code.length ? `${code.join(" and ")} exist but there is no tsconfig.json, so nothing checks them against the generated contract; run \`spec init\` to add one` : "skipped: there is no tsconfig.json and no src/ or test/");
      }
    }
    const proofs = await proving;
    proofs.results.forEach(report);
    ledger = proofs.ledger;
    if (!allOk) skip("tests, traces and explore", restates);
    else {
      for (const dir of dirs) for (const r of await tests(root, dir, specs, (key, ran, keep) => remembered(memory, entry(root, "tests", [dir, key]), ran, keep), mode, memory.fresh)) report(within(dir, result(r)));
      for (const dir of dirs) for (const r of await conformance(path.join(root, dir), machines, scripts.get(dir)!, (key, ran, keep) => remembered(memory, entry(root, "traces", [dir, key]), ran, keep), wrote, mode)) report(within(dir, result(r)));
      for (const dir of dirs) for (const r of await explore(path.join(root, dir), (key, ran, keep) => remembered(memory, entry(root, "explore", [dir, key]), ran, keep), mode, root)) report(within(dir, result(r)));
      // Every stage ran, so every entry still in use was read or written.
      collectGarbage(memory);
    }
  }

  // A spec that is not a valid model has nothing to reconcile yet. Everything is recorded at once, or nothing is.
  const locks = new Map(specs.map((spec) => [spec.file, lock.specs[spec.file] ?? {}]));
  const todos = valid.filter((spec) => !isStd(spec.file)).map((spec) => ({ spec, todo: pending(root, spec, specs, locks) }));
  const contractsToDo = pendingContracts(root, srcFiles, lock);
  const removedSpecs = pendingSpecs(root, specs, lock);
  const review = (ok: boolean, summary: string, detail = "", where?: string, rules: Result["rules"] = []) =>
    report({ ok, stage: "review", summary, detail: ok ? "" : detail, ...(where ? { where } : {}), ...(rules.length ? { rules } : {}) });
  if (accept) {
    try {
      if (JSON.stringify(readSpecs(root)) !== JSON.stringify(specs) || JSON.stringify(readSrc(root)) !== JSON.stringify(srcFiles)
        || JSON.stringify(proofInputs()) !== JSON.stringify(proofsRead))
        review(false, "sources changed while the check ran; nothing was accepted", "      Run `pnpm check` again on the files now on disk.");
    } catch (e) {
      review(false, "sources changed while the check ran; nothing was accepted", indent((e as Error).message));
    }
  }
  const formal = todos.every(({ todo }) => !todo.some((t) => t.status === "story has no rules" || t.status === "not formalized"));
  const record = accept === "reviews" && allOk && formal;
  const recordExceptions = accept === "unproved" && allOk;
  if (record) acceptAllReviews(root, specs, srcFiles, { ...lock, unproved: ledger ?? lock.unproved });
  if (ledger && (record || recordExceptions)) {
    if (recordExceptions) writeLedger(root, ledger, lock);
    const entries = (l: Record<string, Accepted | undefined>) => Object.entries(l).flatMap(([unit, a]) => (a?.unproved ?? []).map((x) => `${unit}: ${x}  [${a!.text}]`));
    const [before, after] = [entries(lock.unproved), entries(ledger)];
    const added = after.filter((x) => !before.includes(x));
    const removed = before.filter((x) => !after.includes(x));
    const line = (sign: string) => (x: string) => `    ${sign} ${x.replace(/  \[[^\]]*\]$/, "")}`;
    if (recordExceptions || removed.length) report({ ok: true, stage: "proof", summary: `${path.relative(root, ledgerFile(root))}: ${added.length} added, ${removed.length} removed`,
      detail: [...added.map(line("+")), ...removed.map(line("-"))].join("\n") });
  }
  const why = accept !== "reviews" ? "then run `pnpm accept`" : !allOk ? "nothing was accepted: fix the stages above first" : "every story needs rules and every rule a quint block before anything can be accepted";
  if (ledger && !record && accept !== "unproved") {
    const ledgerPath = path.relative(root, ledgerFile(root));
    for (const [unit, was] of Object.entries(lock.unproved)) {
      const stillUnproved = new Set(ledger[unit]?.unproved);
      const obsolete = was.unproved.filter((x) => !stillUnproved.has(x));
      if (obsolete.length) review(false, `${ledgerPath}: ${obsolete.length} obsolete simulated-only proof exception${obsolete.length === 1 ? "" : "s"} in ${unit}, ${why}`, indent(obsolete.join("\n")), ledgerPath);
    }
  }
  const items = (todo: Pending[], heading: string) => {
    const shown = moved(todo);
    return todo.map((t) => "    " + showPending(t)).join("\n") + (shown.length ? `\n\n    ${heading}:\n${shown.join("\n")}` : "");
  };
  for (const { spec, todo } of todos) {
    if (record && todo.length) review(true, `${spec.file}: recorded as reconciled: ${todo.map(pendingKey).join("; ")}`, "", spec.file);
    else review(!todo.length, todo.length ? `${spec.file}: ${todo.length} item(s) to reconcile, ${why}` : `${spec.file}: prose and model reconciled for all ${spec.rules.length} rules and ${spec.stories.length} stories`,
      items(todo, "What moved, in full"), spec.file, todo.flatMap((t) => (t.rule ? [{ file: spec.file, key: t.rule.key }] : [])));
  }
  if (removedSpecs.length) review(record, record ? "removed specs recorded as reconciled" : `${removedSpecs.length} removed spec(s) to reconcile, ${why}`,
    removedSpecs.map((p) => "    " + showPending(p)).join("\n"));
  // Contracts are reviewed package by package; one whose package is gone is still listed, under where it was.
  const proved = [...contracts(root, srcFiles).keys()];
  for (const dir of new Set([...dirs, ...contractsToDo.map((t) => codeDirOf(t.where))])) {
    const src = `${dir}src/`;
    const todo = contractsToDo.filter((t) => codeDirOf(t.where) === dir);
    const all = proved.filter((file) => codeDirOf(file) === dir).length;
    if (record && todo.length) review(true, `${src}: recorded as reconciled: ${todo.map((t) => t.where).join("; ")}`, "", src);
    else if (todo.length) review(false, `${src}: ${todo.length} contract(s) to reconcile, ${why}`, items(todo, "The contracts, in full"), src);
    else if (all) review(true, `${src}: the //@ contracts of all ${all} proved files reconciled`, "", src);
  }
}

// --- init ----------------------------------------------------------------------------

/** What a VibeLang shell runs on, and what builds and tests it; `init` adds them at the versions in this package's manifest. */
const VIBELANG = {
  dependencies: ["effect", "@effect/platform-node", "vibelang-runtime"],
  devDependencies: ["vibelang", "vibelang-vite", "vite", "vitest", "@effect/vitest", "@types/node", "@antithesishq/bombadil"],
};

/** Set up a project, preserving its content outside the marked Vibestack instructions. */
export function init(root: string, warn: (message: string) => void = (message) => console.warn(`note: ${message}`)): string[] {
  const pkg = path.join(import.meta.dirname, "..");
  const done: string[] = [];
  const add = (file: string, content: () => string | Buffer) => {
    if (fs.lstatSync(path.join(root, file), { throwIfNoEntry: false })) return;
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content());
    done.push(file);
  };
  const addSkillFiles = (directory: string): void => {
    const existing = fs.lstatSync(path.join(root, directory), { throwIfNoEntry: false });
    if (existing && !existing.isDirectory()) return;
    const source = path.join(pkg, directory);
    for (const name of fs.readdirSync(source).sort()) {
      if (name === ".DS_Store") continue;
      const file = `${directory}/${name}`;
      const entry = fs.lstatSync(path.join(source, name));
      if (entry.isDirectory()) addSkillFiles(file);
      else if (entry.isFile()) add(file, () => fs.readFileSync(path.join(source, name)));
    }
  };
  const hasClaudeDirectory = availableDirectory(path.join(root, ".claude"), warn);
  if (hasClaudeDirectory) {
    addSkillFiles(skillRoot);
    done.push(...linkProjectSkills(root, warn));
  }
  add("SPEC.md", () => fs.readFileSync(path.join(pkg, "SPEC.md"), "utf8"));
  const referenceDir = "vibestack/reference";
  if (["vibestack", referenceDir].every((dir) => fs.lstatSync(path.join(root, dir), { throwIfNoEntry: false })?.isDirectory() ?? true)) {
    const file = `${referenceDir}/typereferences.md`;
    add(file, () => fs.readFileSync(path.join(pkg, file)));
  }
  // The repository's own guard for what the tools write; the rules about this repository's tools stay behind.
  if (hasClaudeDirectory) add(".claude/settings.json", () => {
    const { permissions } = JSON.parse(fs.readFileSync(path.join(pkg, ".claude/settings.json"), "utf8")) as { permissions: { deny: string[]; ask: string[] } };
    return JSON.stringify({ permissions: { ...permissions, deny: permissions.deny.filter((rule) => !rule.includes("/vibestack/")) } }, null, 2) + "\n";
  });
  const agents = path.join(root, "AGENTS.md");
  const procedure = fs.readFileSync(path.join(pkg, "AGENTS.md"), "utf8").trim();
  const previous = fs.existsSync(agents) ? fs.readFileSync(agents, "utf8") : "";
  const eol = previous.includes("\r\n") ? "\r\n" : "\n";
  const section = `<!-- vibestack:start -->${eol}${procedure.replace(/\r?\n/g, eol)}${eol}<!-- vibestack:end -->`;
  const starts = [...previous.matchAll(/<!-- vibestack:start -->/g)];
  const ends = [...previous.matchAll(/<!-- vibestack:end -->/g)];
  if (starts.length !== ends.length || starts.length > 1 || (starts.length === 1 && starts[0].index! > ends[0].index!))
    throw new Error("AGENTS.md: repair the duplicated or incomplete Vibestack markers before running spec init");
  const updated = starts.length ? previous.slice(0, starts[0].index) + section + previous.slice(ends[0].index! + ends[0][0].length)
    : previous.trim() === procedure ? `${section}${eol}`
    : `${previous.trimEnd()}${previous.trim() ? eol + eol : ""}${section}${eol}`;
  if (updated !== previous) {
    fs.writeFileSync(agents, updated);
    done.push("AGENTS.md (Vibestack instructions)");
  }
  const claude = path.join(root, "CLAUDE.md");
  const claudeEntry = fs.lstatSync(claude, { throwIfNoEntry: false });
  const own = claudeEntry?.isFile() ? fs.readFileSync(claude, "utf8") : undefined;
  const instruction = own?.trim();
  if (!claudeEntry || instruction === "" || instruction === "@AGENTS.md") {
    if (claudeEntry) fs.unlinkSync(claude);
    fs.symlinkSync("AGENTS.md", claude, "file");
    done.push("CLAUDE.md (symlink to AGENTS.md)");
  } else if (own !== undefined && !/^@AGENTS\.md\s*$/m.test(own)) {
    const eol = own.includes("\r\n") ? "\r\n" : "\n";
    fs.writeFileSync(claude, `${own.trimEnd()}${eol}${eol}@AGENTS.md${eol}`);
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
  const missing = ["gen/", ".spec-cache/", ".studio/", "dist/", ".vibe/", "test/__traces__/", ...generatedSkillIgnores].filter((l) => !ignored.split("\n").includes(l));
  if (missing.length) { fs.writeFileSync(ignore, ignored + (ignored && !ignored.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n"); done.push(".gitignore"); }
  const manifest = path.join(root, "package.json");
  {
    const json = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")) : {};
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
    if (runtimeDefault) json.engines = { ...json.engines, node: `>=${NODE}` };
    const typed = json.type === undefined;
    if (typed) json.type = "module";
    else if (json.type !== "module") warn(`package.json: "type" is ${JSON.stringify(json.type)}, so Node runs src/ and test/ as CommonJS, where an import statement fails; set "type": "module" if those files use ES imports (gen/ has its own package.json)`);
    if (added.length || typed || needs.length || managed || runtimeDefault) {
      fs.writeFileSync(manifest, JSON.stringify(json, null, 2) + "\n");
      if (added.length) done.push(`package.json scripts: ${added.map(([n]) => n).join(", ")}`);
      if (needs.length) done.push(`package.json VibeLang toolchain: ${needs.join(", ")} (run your package manager's install)`);
      if (managed) done.push("package.json packageManager: pnpm@10.24.0");
      if (runtimeDefault) done.push(`package.json engines.node: >=${NODE}`);
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

/** Every command: what follows its name, and what it does. */
const COMMANDS = [
  ["check", "[<directory>] [--json] [--nightly]", "run every stage; --json prints each result as one line of JSON, then { ok, results, next }; --nightly uses the nightly test profile"],
  ["watch", "[<directory>]", "check again whenever spec/, src/, test/ or tsconfig.json changes"],
  ["gen", "[<directory>] [--if-valid]", "write gen/ from the spec"],
  ["accept", "[<directory>] [unproved]", "record what was reviewed, or the obligations that are simulated only"],
  ["new", "[<path>]", "fill an empty spec/index.md, or write a starter spec/<path>/index.md"],
  ["init", "[<directory>]", "add what a project is missing"],
  ["studio", "[<directory>] [--port <n>]", "open Studio"],
  ["tests", "[<directory>]", "generate tests from a package's declared contracts"],
  ["stories", "gen [--watch] [--check]", "generate component stories"],
  ["tokens", "build|check|apply", "build, check or change design tokens"],
  ["tasks", "[<task>…]", "run the workspace's tasks through Turborepo and its cache"],
];
const USAGE = `usage: spec <command>\n\n${COMMANDS.map(([name, args, does]) => `  ${`${name} ${args}`.padEnd(36)}${does}`).join("\n")}`;

/**
 * Check, then check again whenever spec/, package.json, tsconfig.json, or src/ or test/ of the root or of an owner changes. One process stays warm between runs
 * (the compiler, the toolchain's fingerprint and the cache are already loaded), edits that arrive during a run start
 * one more run after it, and what is unchanged comes from the cache as in any check.
 */
async function watch(root: string) {
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** What changed since the last run began, by path, or undefined where a watcher could not say; and what that run wrote itself. */
  const pending = new Set<string | undefined>([undefined]);
  let wrote = new Map<string, string>();
  const text = (file: string) => { try { return fs.readFileSync(file, "utf8"); } catch { return undefined; } };
  const once = async () => {
    if (running) return;
    running = true;
    while ([...pending].some((file) => file === undefined || wrote.get(file) !== text(file))) {
      pending.clear();
      const started = Date.now();
      console.log(`\n--- ${new Date().toLocaleTimeString()} ---`);
      attach(); // a package that came to own part of the spec tree is watched from the next run
      try {
        const checked = await check(root, false, (r) => console.log(show(r)));
        wrote = checked.wrote;
        console.log(`\nnext: ${checked.next}\n(${((Date.now() - started) / 1000).toFixed(1)}s; watching spec/, src/ and test/, here and in the packages the spec names, and package.json and tsconfig.json; Ctrl-C to stop)`);
      } catch (e) {
        wrote = new Map();
        console.error((e as Error).message);
      }
    }
    pending.clear();
    running = false;
  };
  const changed = (file?: string) => {
    // Editors write temporary files beside the real one; only sources matter.
    if (file && !/\.(md|tsx?|vibex?|dfy|json)$/.test(file)) return;
    pending.add(file);
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
          if (dirs.get(dir)) changed(file ? path.join(root, dir, file) : undefined);
          else if (dir === "apps" || dir === "packages") {
            const child = file && `${dir}/${file}`;
            if (child && inode(child) !== watched.get(child)?.ino) { attach(); changed(); }
          } else if (file === "apps" || file === "packages" || file === "spec" || file === "src" || file === "test") { attach(); changed(); }
          else if (file === "package.json" || file === "tsconfig.json") changed(path.join(root, dir, file));
        });
        watcher.on("error", () => { watcher.close(); if (watched.get(dir)?.watcher === watcher) watched.delete(dir); });
        watched.set(dir, { watcher, ino });
      } catch { /* the directory was removed while attaching; its next parent event retries */ }
    }
  };
  attach();
  await once();
}

// A Node too old to say whether this is the command still reaches the refusal below.
if (import.meta.main ?? true) {
  let root = process.cwd();
  const [command, ...args] = process.argv.slice(2);
  const takes = (...allowed: string[][]) => allowed.some((a) => a.length === args.length && a.every((x, i) => x === "*" || x === args[i]));
  try {
    if (Number(process.versions.node.split(".")[0]) < NODE) throw new Error(`spec needs Node ${NODE} or later; this is Node ${process.versions.node}`);
    const options: Record<string, string[]> = { check: ["--json", "--nightly"], gen: ["--if-valid"], accept: ["unproved"], watch: [], init: [] };
    if (Object.hasOwn(options, command)) {
      const directories = args.filter((arg) => !options[command].includes(arg));
      if (directories.length === 1 && !directories[0].startsWith("-")) {
        root = projectRoot(directories[0]);
        args.splice(args.indexOf(directories[0]), 1);
      }
    }
    if (command === "--help" && takes([])) console.log(USAGE);
    else if (command === "tasks") {
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
      // --if-valid is for `pnpm install`: a spec in the middle of an edit, or a check running, must not make installing fail.
      let release = () => {};
      try {
        release = lockProject(root);
        const specs = readSpecs(root);
        // gen/ is written anew, as a check writes it, but put back as it was unless every spec is valid.
        const [gen, before] = [path.join(root, "gen"), path.join(root, ".spec-cache/gen")];
        fs.rmSync(before, { recursive: true, force: true });
        if (fs.existsSync(gen)) fs.renameSync(gen, before);
        try {
          for await (const { error } of generating({ root, fresh: false, used: new Set() }, specs)) if (error) throw error;
        } catch (e) {
          fs.rmSync(gen, { recursive: true, force: true });
          if (fs.existsSync(before)) fs.renameSync(before, gen);
          throw e;
        }
        fs.rmSync(before, { recursive: true, force: true });
        mirrorGen(root, specs);
      } catch (e) {
        if (!args.length) throw e;
        console.log(`note: gen/ was not generated (${(e as Error).message.split("\n")[0]}); \`pnpm check\` says why`);
      } finally {
        release();
      }
    } else if ((command === "check" && takes([], ["--json"], ["--nightly"], ["--json", "--nightly"], ["--nightly", "--json"])) || (command === "accept" && takes([], ["unproved"]))) {
      const json = args.includes("--json");
      const accept = command === "check" ? false : args[0] === "unproved" ? "unproved" : "reviews";
      // With --json each result is a line as it arrives, and the last line is the whole answer.
      const { ok, results, next } = await check(root, accept, (r) => console.log(json ? JSON.stringify(r) : show(r)), args.includes("--nightly") ? "nightly" : "normal");
      console.log(json ? JSON.stringify({ ok, results, next }) : `\nnext: ${next}`);
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
