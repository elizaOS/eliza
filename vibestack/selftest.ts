// Does each check catch the kind of mistake it exists for? Every case builds a
// scratch project, from the order example (vibestack/examples/order) or from the
// small specs in vibestack/fixtures/, breaks one thing, and asserts which stage of `check` fails.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { request as httpRequest } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Miniflare } from "miniflare";
import { cacheCredentials, collectGarbage } from "./cache.ts";
import { LIB_FILE, isolatedCopies, parseProofFile, readVerdict, splice } from "./prove.ts";
import { exec, run as tool } from "./run.ts";
import { migrateLocks, pendingSpecs, readLedger, showPending, writeLedger } from "./review.ts";
import { nodeRunsVibelang, packageScripts, testInputs, testReceipt } from "./util.ts";
import { profile } from "./testing/profile.ts";
import { canonical, check as conformanceCheck, ConformanceError, departure, replay as replayTrace } from "./conformance.ts";
import { conformance as checkTraces, conformanceFound } from "./conform.ts";
import { acceptContracts, acceptReviews, check, checkVerifiedSource, danglingCitations, expandListHelpers, generated, init, parseSpec, pending, pendingContracts, readSpecs, replay, show, typecheckAll, type Result, type Spec } from "./spec.ts";

const project = path.join(import.meta.dirname, "..");
const EXAMPLE = path.join(project, "vibestack/examples/order");
const read = (file: string, from = project): string => fs.readFileSync(path.join(from, file), "utf8");
const F = "`".repeat(3);
/** What makes the order example a VibeLang package: its manifest, and what its compiler and test runner read. */
const PACKAGE = Object.fromEntries(["package.json", "tsconfig.json", "vitest.config.ts"].map((f) => [f, read(f, EXAMPLE)]));
const roots: string[] = [];
const nodeModules = (function find(dir: string): string {
  const here = path.join(dir, "node_modules");
  return fs.existsSync(here) ? here : dir === path.dirname(dir) ? assert.fail("no node_modules: run pnpm install") : find(path.dirname(dir));
})(project);
after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

/** A scratch project holding the given files. */
function scratch(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "spec-selftest-")));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  if (Object.keys(files).some((f) => /^(src|test)\//.test(f)) && !files["tsconfig.json"]) {
    fs.writeFileSync(path.join(root, "tsconfig.json"), PACKAGE["tsconfig.json"]);
    fs.symlinkSync(nodeModules, path.join(root, "node_modules"), "dir");
  }
  return root;
}
/** A scratch project whose specs are the named fixtures, with their proof files, each changed by `edit` if it is given. */
const fixtures = (names: string[], edit: (files: Record<string, string>) => void = () => {}) => {
  const files = Object.fromEntries(names.flatMap((n) => [`${n}.md`, `${n}.proof.dfy`]
    .filter((f) => f.endsWith(".md") || fs.existsSync(path.join(project, "vibestack/fixtures", f))).map((f) => [`spec/${f}`, read(`vibestack/fixtures/${f}`)])));
  edit(files);
  return scratch(files);
};
/** Copy sources without outputs or live locks; units.ts:genDir marks generated gen/ with package.json. */
function copySources(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, filter: (file) => {
    const name = path.basename(file);
    return !["node_modules", ".spec-cache", ".cache", ".vibe", ".studio", ".turbo", "dist", "generated", "storybook-static", "coverage"].includes(name)
      && !(name === "gen" && fs.existsSync(path.join(file, "package.json")))
      && !(name === "examples" && path.basename(path.dirname(file)) === "vibestack");
  } });
}
/** `root` with its own copy of the toolchain, and of node_modules only the packages and the executables `tools`. */
function toolchain(root: string, ...tools: string[]): string {
  copySources(path.join(project, "vibestack"), path.join(root, "vibestack"));
  const modules = path.join(root, "node_modules");
  fs.mkdirSync(path.join(modules, ".bin"), { recursive: true });
  for (const entry of fs.readdirSync(nodeModules).filter((f) => f !== ".bin"))
    fs.symlinkSync(path.join(nodeModules, entry), path.join(modules, entry), fs.statSync(path.join(nodeModules, entry)).isDirectory() ? "dir" : "file");
  for (const tool of tools.map((t) => process.platform === "win32" ? `${t}.cmd` : t))
    fs.symlinkSync(path.join(nodeModules, ".bin", tool), path.join(modules, ".bin", tool), "file");
  return root;
}
/** `root` with node_modules of its own that also holds these tools as `vibestack`, as a project that installed them has. */
function installed(root: string): string {
  const modules = path.join(root, "node_modules");
  fs.rmSync(modules, { force: true });
  fs.mkdirSync(modules);
  for (const entry of fs.readdirSync(nodeModules)) fs.symlinkSync(path.join(nodeModules, entry), path.join(modules, entry));
  fs.symlinkSync(project, path.join(modules, "vibestack"), "dir");
  return root;
}
/** A line of a test that cites a story or rule, built so that the root's check does not read it as one of its own. */
const citing = (spec: string, heading: string) => `// ${spec}, ${JSON.stringify(heading)}\n`;
/** A spec made of a single rule. */
const ruleSpec = (quint: string, heading = "A rule", title = "T", story = "Story") => `# ${title}\n\n## ${story}\n\n### ${heading}\n\n${F}quint\n${quint}\n${F}\n`;
/** A scratch project with one spec made of a single rule. */
const oneRule = (name: string, heading: string, quint: string) => scratch({ [`spec/${name}.md`]: ruleSpec(quint, heading) });
/** A scratch project with a spec `use` that imports a spec `lib`. */
const libAndUse = (lib: string, use: string) => scratch({ "spec/lib.md": lib, "spec/use.md": use });
/** Hand-written code with a one-line contract. */
const ONE = "//@ pure\nexport function one(): number {\n  //@ ensures \\result === 1\n  return 1;\n}\n";
/** A machine that counts to two. */
const COUNTER = "pure val initial: int = 0\npure def canInc(n: int): bool = n < 2\npure def inc(n: int): int = n + 1\npure def alwaysValid(n: int): bool = 0 <= n and n <= 2";
/** Generated Dafny: one function and its obligation. */
const GENERATED_F = "function f(x: int): int\n{\n  x\n}\n\nlemma f_ensures(x: int)\n  ensures (f(x) >= x)\n{\n}\n";
/** Wait until `ready`, failing with `why` after two minutes. */
async function until(ready: () => boolean | Promise<boolean>, why: () => string = () => "timed out") {
  const end = Date.now() + 120_000;
  while (!(await ready())) {
    assert.ok(Date.now() < end, why());
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// The order example with whatever awaits sign-off here accepted, checked once
// so that every copy starts with its cache: an edit then re-runs only what it changes.
const pristine = scratch({});
for (const file of ["spec/index.md", "src", "test"]) fs.cpSync(path.join(EXAMPLE, file), path.join(pristine, file), { recursive: true });
for (const [file, text] of Object.entries(PACKAGE)) fs.writeFileSync(path.join(pristine, file), text);
fs.symlinkSync(nodeModules, path.join(pristine, "node_modules"), "dir");
for (const spec of readSpecs(pristine)) acceptReviews(pristine, spec);
acceptContracts(pristine);
const pristineCheck = await check(pristine);
assert.equal(pristineCheck.ok, true, pristineCheck.results.map(show).join("\n"));

/** A copy of the pristine project with `edit` applied to one file. */
function copyOfProject(file?: string, edit: (text: string) => string = (s) => s): string {
  const root = scratch({});
  fs.cpSync(pristine, root, { recursive: true });
  if (!file) return root;
  const target = path.join(root, file);
  const before = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const changed = edit(before);
  assert.notEqual(changed, before, "the edit must change the file");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, changed);
  return root;
}

/** Check a project: the stages that failed, and what a stage said that matches a pattern. */
async function run(root: string, accept: false | "reviews" | "unproved" = false) {
  const { results, next } = await check(root, accept);
  const text = results.map(show).join("\n");
  return {
    text,
    next,
    failed: [...new Set(results.filter((r) => !r.ok).map((r) => r.stage))],
    said: (stage: Result["stage"], pattern: RegExp) => results.find((r) => r.stage === stage && pattern.test(`${r.summary}\n${r.detail}`)),
  };
}
const failedStages = async (file: string, edit: (text: string) => string) => (await run(copyOfProject(file, edit))).failed;
const pendingItems = (root: string) => readSpecs(root).flatMap((spec) => pending(root, spec).map((p) => `${p.where.split("  ")[1]}: ${p.status}${p.note ?? ""}`));
/** gen/ for one spec, as `check` and `spec gen` generate it. */
const gen = async (root: string, spec: Spec) => generated(root, spec, await typecheckAll({ root, fresh: true, used: new Set() }, readSpecs(root)).get(spec.name)!, new Map());
/** gen/ for every spec of a project, in dependency order: the files it holds. */
async function genAll(root: string): Promise<string[]> {
  const specs = readSpecs(root);
  const typed = typecheckAll({ root, fresh: true, used: new Set() }, specs);
  const models = new Map();
  for (const spec of specs) generated(root, spec, await typed.get(spec.name)!, models);
  return fs.readdirSync(path.join(root, "gen")).sort();
}
/** Run a fresh CLI process so toolchain fingerprints cannot carry over from another invocation. */
const runCli = (script: string, root: string, ...args: string[]) => exec(process.execPath, [script, ...args], root);
const unguarded = (s: string) => s.replace("o.status == Draft and o.units > 0", "o.status == Draft");
const notInductive = (s: string) => s.replace(/### Drafts and cancelled orders hold no money[\s\S]*?```\n\n/, "");

// Each check uses run.ts's tool queue; bound the fixture graphs and independent CLI processes alive beside it.
describe("each check catches its own kind of mistake", { concurrency: Math.min(4, os.availableParallelism()) }, () => {
  test("collection operations preserve structural equality, total lookups and exact integer results", async () => {
    const forged = oneRule("forged", "Forged builtin", "pure def std_getOr_forged(m: int -> int, key: int, fallback: int): int = 42\npure def readMap(m: int -> int): int = std_getOr_forged(m, 1, 0)");
    await assert.rejects(gen(forged, parseSpec(forged, "spec/forged.md")), /reserved for generated collection operations/);
    const root = oneRule("collections", "Collections", `type Item = { n: int }
pure def same(a: Item, b: Item): bool = a == b
pure def itemAt(xs: List[int], i: int): int = xs.nthOr(i, 7)
pure def remove(xs: List[int], i: int): List[int] = xs.removeAt(i)
pure def lookup(m: int -> int, key: int): int = m.getOr(key, 9)
pure def lazyLookup(m: int -> int, n: int): int = if (m.keys().contains(1)) m.get(1) else n + 9007199254740991
pure def add(a: int, b: int): int = a + b`);
    const model = await gen(root, parseSpec(root, "spec/collections.md"));
    const domain = await import(path.join(root, "gen/collections.ts"));
    assert.equal(domain.same({ n: 1 }, { n: 1 }), true);
    assert.equal(domain.same({ n: 1 }, { n: 2 }), false);
    assert.equal(domain.itemAt([3], -1), 7);
    assert.equal(domain.itemAt([3], 0), 3);
    assert.deepEqual(domain.remove([1, 2, 3], 1), [1, 3]);
    assert.deepEqual(domain.remove([1, 2, 3], 4), [1, 2, 3]);
    assert.equal(domain.lookup({ 1: 3 }, 1), 3);
    assert.equal(domain.lookup({ 1: 3 }, 2), 9);
    assert.equal(domain.lazyLookup({ 1: 7 }, 1), 7);
    assert.equal(domain.lazyLookup({}, 0), Number.MAX_SAFE_INTEGER);
    assert.throws(() => domain.lazyLookup({}, 1), RangeError);
    assert.throws(() => domain.add(Number.MAX_SAFE_INTEGER, 1), RangeError);
    assert.doesNotMatch(model.render(""), /Number\.isSafeInteger|function exact_/);
  });

  test("transitions return effects and step rules inspect their order", async () => {
    const lists = oneRule("lists", "State and effects share a type", `type State = List[int]
type Did = { state: State, out: List[int] }
pure val initial: State = List()
pure def push(s: State, n: int): Did = { state: s.append(n), out: List(n) }
pure def stepHasOneEffect(before: State, after: State, out: List[int]): bool = out.length() == 1`);
    const model = await gen(lists, parseSpec(lists, "spec/lists.md"));
    assert.equal(model.evals.find((e) => e.name === "stepHasOneEffect")?.params.at(-1)?.from, "emitted");
    const root = fixtures(["mailer"]);
    const swapped = fixtures(["mailer"], (f) => { f["spec/mailer.md"] = f["spec/mailer.md"].replace("List(Saved({ n: n }), Sent({ n: n }))", "List(Sent({ n: n }), Saved({ n: n }))"); });
    const [result, wrongOrder] = await Promise.all([run(root), run(swapped)]);
    assert.deepEqual(result.failed, ["review"], result.text);
    // A counterexample shows what each event output.
    assert.ok(wrongOrder.said("always", /a step breaks .*A message is saved before anything is sent[\s\S]*send\{"n":\d+\}\s+-> sent = 1, out \[\{"tag":"Sent"/), wrongOrder.text);
    const domain = await import(path.join(root, "gen/mailer.ts"));
    assert.deepEqual(domain.step(domain.initial, { type: "send", n: 4 }), {
      state: { sent: 1 }, out: [{ tag: "Saved", n: 4 }, { tag: "Sent", n: 4 }],
    });
    assert.deepEqual(domain.step(domain.initial, { type: "send", n: 0 }), { state: domain.initial, out: [] });
    const mailer = await gen(root, parseSpec(root, "spec/mailer.md"));
    const found = conformanceFound(mailer, parseSpec(root, "spec/mailer.md"), [], []);
    const emitted = domain.step(domain.initial, { type: "send", n: 4 });
    assert.equal(departure(domain, found, [{ state: domain.initial }, { event: { type: "send", n: 4 }, state: emitted.state, out: emitted.out }]), undefined);
    assert.match(departure(domain, found, [{ event: { type: "send", n: 4 }, state: emitted.state, out: emitted.out.toReversed() }])?.why ?? "", /effects differ/);
    // Replay compares what TypeScript outputs with what Quint does.
    const trace = [{ state: domain.initial, out: [] }, { event: { type: "send", n: 4 }, state: emitted.state, out: emitted.out }];
    replay(domain, trace, mailer);
    assert.throws(() => replay({ ...domain, step: (s: unknown, e: unknown) => ({ ...domain.step(s, e), out: [] }) }, trace, mailer), /disagree on what \{"type":"send","n":4\} outputs/);
  });

  test("conformance observes scalar states, real program traces, and only demands behavior present in the oracle", async () => {
    const root = oneRule("counter", "Count", "pure val initial: int = 0\npure def canInc(n: int): bool = n < 2\npure def inc(n: int): int = n + 1\npure def alwaysValid(n: int): bool = 0 <= n and n <= 2");
    const spec = parseSpec(root, "spec/counter.md");
    const model = await gen(root, spec);
    const domain = await import(path.join(root, "gen/counter.ts"));
    const found = conformanceFound(model, spec, [[{ state: 0 }, { event: { type: "inc" }, state: 1 }, { event: { type: "inc" }, state: 2 }]], []);
    const states = new Map<string, number>();
    const counting = {
      reset: () => states.clear(),
      dispatch: (key: string) => { const n = states.get(key) ?? 0; if (n === 2) return "refused"; states.set(key, n + 1); return "accepted"; },
      observe: (key: string) => states.get(key) ?? 0,
    };
    await conformanceCheck(domain, found, counting, { walks: 3, steps: 6 });
    // One counter shared by every key: the failure carries its shrunk trace as data, which replays the same way.
    let shared = 0;
    const leaky = { reset: () => { shared = 0; }, dispatch: () => { shared++; return "accepted" as const; }, observe: () => shared };
    const failure = await conformanceCheck(domain, found, leaky, { walks: 1, steps: 1 }).catch((e: unknown) => e);
    assert.ok(failure instanceof ConformanceError && failure.trace.length === 1 && /should be 0, but the application has 1/.test(failure.message), String(failure));
    await assert.rejects(replayTrace(domain, found, leaky, failure.trace), ConformanceError);
    await replayTrace(domain, found, counting, failure.trace);
    assert.equal(departure(domain, found, [{ state: 0 }, { event: { type: "inc" }, state: 1 }]), undefined);
    assert.match(departure(domain, found, [{ event: { type: "inc" } }])?.why ?? "", /no observed state/);
    fs.mkdirSync(path.join(root, "test/traces"), { recursive: true });
    fs.writeFileSync(path.join(root, "test/traces/counter.jsonl"), '{"state":0}\n{"event":{"type":"inc"},"state":1}\n');
    fs.writeFileSync(path.join(root, "driver.json"), '{"offset":0,"limit":2}');
    fs.writeFileSync(path.join(root, "driver.mjs"), 'import fs from "node:fs"; import readline from "node:readline"; let n=0; for await (const line of readline.createInterface({input:process.stdin})) { const request=JSON.parse(line), {offset,limit}=JSON.parse(fs.readFileSync("driver.json","utf8")); if (!request.event) n=0; else if (n<limit) n++; console.log(JSON.stringify({state:n+offset})); }');
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({type:"module",scripts:{"driver:counter":`${JSON.stringify(process.execPath)} driver.mjs`}}));
    const machines = new Map([["counter", { domain, model, found }]]);
    const departs = async () => (await checkTraces(root, machines, packageScripts(root))).filter(([ok]) => !ok).map(([, , summary, detail]) => `${summary}\n${detail}`);
    assert.deepEqual(await departs(), []);
    // A driver that starts elsewhere, or takes the event the spec refuses in the last state of a trace, departs.
    fs.writeFileSync(path.join(root, "driver.json"), '{"offset":1,"limit":2}');
    assert.match((await departs()).join(), /^script driver:counter: the program departs[\s\S]*reset/);
    fs.writeFileSync(path.join(root, "driver.json"), '{"offset":0,"limit":3}');
    assert.match((await departs()).join(), /^script driver:counter: the program departs[\s\S]*line 4/);
    // So does a trace the program wrote, at the first line that differs.
    fs.writeFileSync(path.join(root, "driver.json"), '{"offset":0,"limit":2}');
    fs.writeFileSync(path.join(root, "test/traces/counter.jsonl"), '{"state":0}\n{"event":{"type":"inc"},"state":2}\n');
    assert.match((await departs()).join(), /^test\/traces\/counter\.jsonl: the program departs[\s\S]*line 2/);

    const quiet = oneRule("quiet", "Wait", "pure val initial: int = 0\npure def stay(n: int): int = n\npure def alwaysZero(n: int): bool = n == 0");
    const quietSpec = parseSpec(quiet, "spec/quiet.md"), quietModel = await gen(quiet, quietSpec);
    await conformanceCheck(await import(path.join(quiet, "gen/quiet.ts")), conformanceFound(quietModel, quietSpec, [[{ state: 0 }, { event: { type: "stay" }, state: 0 }]], []),
      { reset() {}, dispatch: () => "accepted", observe: () => 0 }, { walks: 1, steps: 2 });
  });

  test("set canonicalization follows tagged variants and preserves list order", async () => {
    const root = oneRule("mixed", "Values", "type Values = A({ values: Set[int] }) | B({ values: List[int] })\npure val initial: Values = A({ values: Set(1, 2) })\npure def list(v: Values): Values = B({ values: List(1, 2) })");
    const model = await gen(root, parseSpec(root, "spec/mixed.md"));
    assert.equal(canonical({ tag: "A", values: [1, 2] }, model.shape!), canonical({ tag: "A", values: [2, 1] }, model.shape!));
    assert.notEqual(canonical({ tag: "B", values: [1, 2] }, model.shape!), canonical({ tag: "B", values: [2, 1] }, model.shape!));
  });

  test("a fresh spec with enum and bool parameters and an unguarded transition passes everything but review", async () => {
    const root = fixtures(["door"]);
    const { failed, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
    const log = fs.readFileSync(path.join(root, "gen/proof/door.log"), "utf8");
    assert.match(log, /Dafny auditor completed/);
    assert.doesNotMatch(log, /every assertion isolated/, "a unit that proves whole is not verified again");
  });

  test("a missing guard is found by simulation, as a trace that the same seed gives again and that is remembered, and the later stages say they were skipped", async () => {
    const root = copyOfProject("spec/index.md", unguarded);
    const first = await run(root);
    fs.rmSync(path.join(root, ".spec-cache"), { recursive: true });
    const [again, remembered] = [await run(root), await run(root)];
    const trace = first.said("always", /./);
    assert.equal(trace?.ok, false, first.text);
    assert.match(trace!.detail, /seed \d+; to simulate again: pnpm exec quint run gen\/index\.run\.qnt .* --seed \d+/);
    assert.equal(again.said("always", /./)?.detail, trace!.detail, "the same harness gives the same trace");
    assert.equal(remembered.said("always", /./)?.detail, trace!.detail);
    assert.ok(!fs.existsSync(path.join(root, "gen/traces")), "a failing simulation is not run again for the same harness");
    assert.ok(first.said("skipped", /^types, proof, tests and traces: /), first.text);
    assert.match(first.next, /^always \(spec\/index\.md\) is the first ✗/);
    // The nightly profile is part of what is remembered and simulates a different, reproducible set of traces.
    const fuzzed = await exec(process.execPath, [path.join(project, "vibestack/spec.ts"), "check", "--json", "--nightly"], root);
    const seeded = JSON.parse(fuzzed.stdout).results.find((r: Result) => r.stage === "always").detail;
    assert.match(seeded, /seed \d+; to simulate again/);
    assert.notEqual(seeded.match(/seed (\d+)/)[1], trace!.detail.match(/seed (\d+)/)![1]);
    const repeated = await exec(process.execPath, [path.join(project, "vibestack/spec.ts"), "check", "--json", "--nightly"], root);
    assert.equal(JSON.parse(repeated.stdout).results.find((r: Result) => r.stage === "always").detail, seeded);
    assert.equal((await run(root)).said("always", /./)?.detail, trace!.detail, "the normal profile retains its own seed and remembered result");
  });

  test("a rule set that holds in simulation but is not inductive is caught by the proof, and the deleted rule awaits review", async () => {
    const { failed, said, text } = await run(copyOfProject("spec/index.md", notInductive));
    assert.deepEqual(failed, ["proof", "review"], text);
    assert.ok(said("review", /removed or renamed/), text);
  });

  test("rules too strict to ever reach a goal are caught by a `sometimes` rule", async () => {
    const failed = await failedStages("spec/index.md", (s) => s.replace("o.paid + amount <= o.due", "o.paid + amount < o.due"));
    assert.ok(failed.includes("sometimes"), failed.join());
  });

  test("a guard that never allows its event is caught, although every rule holds of the event trivially", async () => {
    // Cancelling refunds every payment, so a reopen that needs money paid can never happen.
    const { failed, text, said } = await run(copyOfProject("spec/index.md", (s) => s.replace("canReopen(o: Order): bool = o.status == Cancelled", "canReopen(o: Order): bool = o.status == Cancelled and o.paid > 0")));
    assert.ok(failed.includes("sometimes"), text);
    assert.ok(said("sometimes", /reopen in .* never happened: its guard canReopen refused it/), text);
  });

  test("a guard that needs values the simulator does not try says which to define", async () => {
    const { text, said } = await run(copyOfProject("spec/index.md", (s) => s.replace("o.status == Pending and amount > 0 and neverMoreThanPaid", "o.status == Pending and amount > 6 and neverMoreThanPaid")));
    assert.ok(said("sometimes", /takeBack in .* never happened: .*define amountValues/), text);
    assert.ok(!/\bpay in .* never happened/.test(text), text);
  });

  test("a guard that never refuses its event is reported without failing", async () => {
    // Every reachable lamp has counted its flips, so this guard restates a rule and restricts nothing.
    const { failed, text, said } = await run(fixtures(["lamp"], (f) => {
      f["spec/lamp.md"] = f["spec/lamp.md"].replace("pure def toggle(", "pure def canToggle(l: Lamp): bool = l.flips >= 0\npure def toggle(");
    }));
    assert.deepEqual(failed, ["review"], text);
    assert.ok(said("sometimes", /never seen to refuse it .*: canToggle\b/), text);
  });

  test("prose edited without the model is flagged for review, and accept records it only while every other stage passes", async () => {
    const reworded = (s: string) => s.replace("Every unit costs the same", "Each unit has one price");
    const root = copyOfProject("spec/index.md", reworded);
    assert.deepEqual((await run(root)).failed, ["review"]);
    assert.deepEqual((await run(root, "reviews")).failed, []);
    assert.deepEqual((await run(copyOfProject("spec/index.md", (s) => unguarded(reworded(s))), "reviews")).failed, ["always", "review"]);
  });

  test("a rule with no formal half is flagged", async () => {
    const failed = await failedStages("spec/index.md", (s) => s + "\n### Refunds arrive within three days\n\nNot yet modelled.\n");
    assert.deepEqual(failed, ["review"]);
  });

  test("Quint outside the supported subset, or that the translator cannot render faithfully, is refused", async () => {
    const refused: [string, (s: string) => string][] = [
      ["an operator outside the subset", (s) => s.replace("pure val unitPrice = 5", "pure val unitPrice = 5^1")],
      ["integer beyond 2^53", (s) => s.replace("pure val unitPrice = 5", "pure val unitPrice = 9007199254740993")],
      ["parameter named like a variant", (s) => s.replace("canCancel(o: Order): bool = o.status == Pending", "canCancel(o: Order): bool = o.status == Pending\npure def isIt(o: Order, Draft: Status): bool = o.status == Draft")],
      ["rule name with the wrong capital", (s) => s.replace(/alwaysPaidWithinDue/g, "alwayspaidWithinDue")],
      ["TypeScript keyword as a name", (s) => s.replace(/\bcancel\b/g, "delete").replace(/canCancel/g, "canDelete")],
      ["parameter that collides with the harness's state variable", (s) => s.replace(/\bamount\b/g, "state")],
      ["duplicate rule heading", (s) => s.replace("### An order can be cancelled", "### A pending order can be cancelled, refunding every payment")],
    ];
    for (const [what, edit] of refused) assert.deepEqual(await failedStages("spec/index.md", edit), ["model"], what);
  });

  test("names, constructs, sample sets and shapes that would be translated wrongly are refused, and a constant named like a rule is not", async () => {
    const sampled = "type S = { n: int }\npure val initial: S = { n: 0 }\npure def canAdd(s: S, amount: int): bool = amount > 0\npure def add(s: S, amount: int): S = { n: s.n + amount }";
    const refused: [string, string, RegExp][] = [
      ["a type named like a generated one", "type Event = { n: int }\npure val initial: Event = { n: 0 }", /cannot be used as a name/],
      ["a definition named like a JavaScript global", "pure val initial: int = 0\npure def Number(n: int): int = n", /cannot be used as a name/],
      ["a parameter named like Dafny's standard library", "pure val initial: int = 0\npure def f(Std: int): int = Std", /`Std` cannot be used as a name/],
      ["a set of two computed members", "pure val initial: int = 0\npure def pair(a: int, b: int): int = Set(a, b).size()", /could hold the same value twice/],
      ["a variant field called tag", "type P = A({ tag: int }) | B\npure val initial: int = 0\npure def tick(n: int): int = n", /cannot be called `tag`/],
      ["a match binder used as a whole value", "type N = { n: int }\ntype P = A(N) | B\npure val initial: int = 0\npure def g(r: N): int = r.n\npure def f(p: P): int = match p { | A(x) => g(x) | _ => 0 }\npure def tick(n: int): int = n", /is what a match arm carries/],
      ["state declared by hand", "pure val initial: int = 0\nvar n: int", /only types, imports, `pure val` and `pure def` belong in a spec/],
      ["a constant without a value", "pure val initial: int = 0\nconst n: int\npure def tick(k: int): int = k", /a `const` is an opaque function/],
      ["a step rule's output where no transition outputs", "pure val initial: int = 0\npure def tick(n: int): int = n\npure def stepQuiet(a: int, b: int, out: List[int]): bool = true", /no transition returns `\{ state, out \}`/],
      ["a refinement of a machine not imported", "pure val initial: int = 0\npure def tick(n: int): int = n\npure def refinesL(n: int): int = n", /no machine is imported as L/],
      ["a rule written as a `pure val`", "pure val initial: int = 0\npure val alwaysNever = false", /is a `pure def` with parameters/],
      ["a sample of the wrong type", 'pure val amountValues = Set("bad")\n' + sampled, /amountValues.*holds.*parameter amount/],
      ["an unused sample set", "pure val typoValues = Set(1)\n" + sampled, /no parameter is named typo/],
      ["a sample set used at runtime", "pure val amountValues = Set(1)\n" + sampled + "\npure def total(k: int): int = amountValues.size()", /amountValues.*(simulat|runtime|sample)/],
      ["identical record shapes", "type A = { n: int }\ntype B = { n: int }\npure def convert(a: A): B = { n: a.n }", /have the same fields/],
      ["a definition with no parameters", "pure def one(): int = 1", /parameter/],
      ["two declarations on one line", "pure val first = 1 pure val second = 2", /declaration|own line|rule/],
      ["an initial state without a transition", "pure val initial: int = 0", /transition/],
      ["a set of records", "type A = { n: int }\npure def count(xs: Set[A]): int = xs.size()", /set|Set/],
      ["a map into records", "pure def records(xs: Set[int]): Set[{ n: int }] = xs.map(x => { n: x })", /set|Set|record/],
      ["== on values that hold a set", "type A = { s: Set[int] }\npure def same(a: A, b: A): bool = a == b", /a set is a sequence/],
      ["a map keyed by booleans", "pure def flags(k: bool): bool -> int = Map(k -> 1)", /keys must be/],
      ...["fairOn", "fairEnabled", "arguments", "implements"].map((name): [string, string, RegExp] =>
        [`reserved generated name ${name}`, `pure def ${name}(n: int): int = n`, /cannot be used as a name/]),
    ];
    const [constant, ...results] = await Promise.all(["pure val stepLimit = 3\npure def lawPositive(k: int): bool = stepLimit > 0", ...refused.map(([, quint]) => quint)]
      .map((quint) => run(oneRule("t", "A rule", quint))));
    refused.forEach(([what, , message], i) => assert.equal(results[i].said("model", message)?.ok, false, `${what}\n${results[i].text}`));
    assert.ok(!constant.failed.includes("model"), constant.text);
  });

  test("a comment or string left open at the end of a quint block is refused, so prose can never become model", async () => {
    // Prose is tangled as `// …`; inside an open block comment, `// */ code` would be code that no review or cache key sees as such.
    const { said, text } = await run(copyOfProject("spec/index.md", (s) => s.replace("pure val unitPrice = 5", "pure val unitPrice = 5\n/*")));
    assert.equal(said("model", /a comment is still open at the end of this quint block/)?.ok, false, text);
  });

  test("who sent an event travels beside it, a guard takes only what it uses, a step rule sees the event, and deep goals are found", async () => {
    const vault = (edit: (s: string) => string = (s) => s) => fixtures(["vault"], (f) => { f["spec/vault.md"] = edit(f["spec/vault.md"]); });
    const root = vault();
    const [ok, broken, stray] = await Promise.all([
      run(root),
      run(vault((s) => s.replace("{ ...v, open: false }", "{ ...v, open: true }"))),
      run(vault((s) => s.replace("canRelabel(v: Vault, by: Actor): bool = by", "canRelabel(v: Vault, who: Actor): bool = who"))),
    ]);
    assert.deepEqual(ok.failed, ["review"], ok.text);
    assert.ok(ok.said("sometimes", /sometimesLate is reachable/), ok.text); // thirty ticks: beyond a trace of 20 events
    const gen = await import(path.join(root, "gen/vault.ts"));
    assert.deepEqual(gen.parseEvent({ type: "open", by: "Owner" }), { type: "open" });
    assert.equal(gen.enabled(gen.initial, { type: "open" }, "Guest"), false);
    assert.equal(gen.parseSender("Owner"), "Owner");
    assert.equal(gen.parseSender("Mallory"), undefined);
    // The traces stage knows the spec's events come from someone.
    assert.match(departure(gen, { sender: true } as never, [{ event: { type: "open" }, by: "Mallory", state: gen.initial }])?.why ?? "", /valid sender/);
    assert.equal(gen.step(gen.initial, { type: "relabel", label: "a" }, "Owner").label, "a");
    // A counterexample shows each event with only what it changed.
    assert.ok(broken.said("always", /a step breaks[\s\S]*\n\s+close\s+-> open = true\n/), broken.text);
    assert.ok(stray.said("model", /canRelabel: `who` must be a parameter of relabel/), stray.text);
  });

  test("a secret reaches no place whose type is not secret, but through a declassify function that review names", async () => {
    const card = (edit: (s: string) => string = (s) => s) => fixtures(["card"], (f) => { f["spec/card.md"] = edit(f["spec/card.md"]); });
    const shown = 'Shown({ text: if (declassifyNone(w.card)) "none" else "saved" })';
    const leaks: [string, (s: string) => string, RegExp][] = [
      ["shown", (s) => s.replace(shown, "Shown({ text: w.card })"), /\bhint \(spec\/card\.md:\d+\): a secret reaches the field text, of type str, which is not secret/],
      ["choosing what is shown", (s) => s.replace("declassifyNone(w.card)", 'w.card == ""'), /\bhint .*: a secret reaches the field text/],
      ["through a helper", (s) => s.replace(shown, "show(w.card)").replace("pure def hint(", "pure def show(t: str): Effect = Shown({ text: t })\npure def hint("), /\bshow \(.*: a secret reaches the field text/],
      ["kept in a field that is not secret", (s) => s.replace("{ card: SecretCard, out", "{ card: SecretCard, note: str, out").replace('{ card: "", out', '{ card: "", note: "", out').replace("{ ...w, card: card }", "{ ...w, card: card, note: card }"), /\bsave .*: a secret reaches the field note/],
      ["deciding whether an event may happen", (s) => s.replace("pure def pay(", 'pure def canPay(w: Wallet): bool = w.card == "4111"\npure def pay('), /\bcanPay .*: what it returns depends on a secret, but its type bool is not secret/],
    ];
    const [ok, ...broken] = await Promise.all([run(card()), ...leaks.map(([, edit]) => run(card(edit)))]);
    assert.deepEqual(ok.failed, ["review"], ok.text);
    assert.ok(ok.said("review", /new, and declassifies a secret through declassifyNone/), ok.text);
    leaks.forEach(([what, , message], i) => assert.equal(broken[i].said("model", message)?.ok, false, `${what}\n${broken[i].text}`));
  });

  test("an opaque function is simulated as a table its laws allow, chosen per trace, and proved only through its laws", async () => {
    const proof = "lemma issue_ensures(d: Desk, name: string)\n  ensures (inv(d) ==> alwaysTheLastCodeIsADigit(issue(d, name)))\n{\n  lawCodeIsADigit_ensures(name);\n}\n";
    const badge = (edit: (s: string) => string = (s) => s, files: Record<string, string> = { "spec/badge.proof.dfy": proof }) =>
      fixtures(["badge"], (f) => { f["spec/badge.md"] = edit(f["spec/badge.md"]); Object.assign(f, files); });
    const root = badge();
    const [ok, unproved, chance, contradiction] = await Promise.all([
      run(root),
      run(badge(undefined, {})),
      run(badge((s) => s.replace("0 <= d.last and d.last <= 9", "d.last <= 5"))),
      run(badge((s) => s.replace("pure def lawCodeIsADigit", "pure def lawCodeIsNegative(name: str): bool = code(name) < 0\npure def lawCodeIsADigit"),
        { "spec/user.md": `# User\n\n## Group\n\n### Uses badges\n\n${F}quint\nimport badge as B from "./badge"\npure val two = 2\n${F}\n` })),
    ]);
    assert.deepEqual(ok.failed, ["review"], ok.text);
    assert.ok(ok.said("proof", /^badge\.ts: all 3 obligations proved/), ok.text);
    assert.match(fs.readFileSync(path.join(root, "gen/proof/badge/badge.dfy"), "utf8"), /^function \{:axiom\} code\(p0: string\): int$[\s\S]*^lemma \{:axiom\} lawCodeIsADigit_ensures\(name: string\)$/m);
    const gen = await import(path.join(root, "gen/badge.ts"));
    assert.throws(() => gen.step(gen.initial, { type: "issue", name: "a" }), /code is opaque in spec\/badge\.md/);
    gen.opaque.code = (name: string) => name.length;
    assert.equal(gen.step(gen.initial, { type: "issue", name: "abc" }).last, 3);
    assert.equal(unproved.said("proof", /^badge\.ts: 2 of 3 obligations not proved/)?.ok, false, unproved.text);
    assert.equal(chance.said("always", /breaks "Story: Issue a badge \/ The last code issued is a digit"/)?.ok, false, chance.text);
    assert.equal(contradiction.said("always", /no table the simulator chose for code satisfies the laws stated with them/)?.ok, false, contradiction.text);
    assert.equal(contradiction.said("model", /import of badge: it declares opaque functions \(code\)/)?.ok, false, contradiction.text);
  });
  test("a rule broken only on the way to a `sometimes` goal is still reported", async () => {
    // Only the witness search goes deep enough: the goal is three steps away and the break is on the way.
    const quint = "pure val initial: int = 0\npure def up(n: int): int = n + 1\npure def canUp(n: int): bool = n < 5\npure def alwaysBelowThree(n: int): bool = n < 3\npure def sometimesFour(n: int): bool = n == 4";
    const { failed, text } = await run(oneRule("t", "Counting", quint));
    assert.ok(failed.includes("always"), text);
    assert.ok(!failed.includes("sometimes"), text);
  });

  test("hand-written code that changes what it is checked against is refused or flagged", async () => {
    const { said, text } = await run(copyOfProject("src/ledger.ts", (s) => s.replace(/(\/\/@ ensures)/, "//@ requires true\n$1")));
    assert.ok(said("proof", /^src-ledger\.ts: .*under 2 \/\/@ requires/), text);
  });

  test("the application's types and tests are checked, in VibeLang and in the TypeScript beside it, on a Node that loads both; test/ that nothing runs gets Vitest, as `spec init` sets it up", async () => {
    const plainRoot = installed(fixtures(["door"], (f) => Object.assign(f, {
      "src/wrong.ts": 'export const wrong: number = "x";\n',
      "test/never.test.vibe": citing("spec/door.md", "Story: Use the door") + 'import { assert, it } from "@effect/vitest"\nimport { wrong } from "../src/wrong.ts"\nit("never holds", () => { assert.strictEqual(wrong, 2) })\n',
    })));
    const failingRoot = copyOfProject("test/app.test.vibe", (s) => s + "\n" + citing("spec/index.md", "Story: Check out") + 'it("never holds", () => { assert.strictEqual(1, 2) })\n');
    const manifest = JSON.parse(read("package.json", failingRoot));
    manifest.scripts.test = `node --input-type=module -e "delete process.env.NO_COLOR; process.env.FORCE_COLOR='1'; process.argv=[process.argv[0],'vitest','run']; await import(new URL('vitest.mjs',import.meta.resolve('vitest/package.json')));"`;
    fs.writeFileSync(path.join(failingRoot, "package.json"), JSON.stringify(manifest));
    const [mistyped, failing, plain] = await Promise.all([
      run(copyOfProject("src/app.vibe", (s) => s + "\nconst wrong: number = \"x\"\n")),
      run(failingRoot),
      run(plainRoot),
    ]);
    const unfit = "application does not fit the generated contract";
    assert.equal(mistyped.said("types", /./)?.summary, unfit, mistyped.text);
    assert.match(stripVTControlCharacters(mistyped.text), /src\/app\.vibe(?:\(\d+,\d+\):|:\d+:\d+ -) error TS2322/);
    assert.deepEqual(failing.failed, ["tests"], failing.text);
    // Colored runner output still starts at the failure list and names the failed assertion.
    assert.ok(failing.said("tests", /^fail\n +⎯+ Failed Tests 1 ⎯+\n[\s\S]*test\/app\.test\.vibe > never holds[\s\S]*expected 1 to equal 2/), failing.text);
    assert.deepEqual(plain.failed, ["types", "tests", "review"], plain.text);
    assert.equal(plain.said("types", /./)?.summary, unfit, plain.text);
    assert.match(stripVTControlCharacters(plain.text), /src\/wrong\.ts(?:\(1,14\):|:1:14 -) error TS2322/);
    assert.ok(plain.said("tests", /^test\/ had nothing to run it: added "test": "vitest run" to package\.json, and vitest\.config\.ts, as `spec init` does\n$/), plain.text);
    assert.ok(plain.said("tests", /^fail\n[\s\S]*never holds/), plain.text);
    const initialized = scratch({});
    init(initialized, () => {});
    assert.deepEqual([JSON.parse(read("package.json", plainRoot)).scripts, read("vitest.config.ts", plainRoot)], [{ test: "vitest run" }, read("vitest.config.ts", initialized)]);
    const untyped = copyOfProject();
    fs.rmSync(path.join(untyped, "tsconfig.json"));
    assert.ok((await run(untyped)).failed.includes("types"));
    // The types stage also refuses a Node that cannot load `.vibe` sources: below either floor, or between the two lines.
    assert.deepEqual(["22.22.2", "22.22.3", "23.11.1", "24.5.0", "24.11.1", "26.0.0"].map((v) => nodeRunsVibelang(v)), [false, true, false, false, true, true]);
  });

  test("a test that reaches only generated code, which the spec proves, is caught: a file that imports nothing else, and a test that reaches nothing else through the helpers it calls; two test files of one runner and language are a note", async () => {
    const root = copyOfProject("test/app.test.vibe", (s) => s.replace('from "../src/app.vibe"\n', '$&import { initial } from "../gen/index.effect.vibe"\n')
      + "\n" + citing("spec/index.md", "A new order is an empty draft") + 'it("a new order is a draft", () => { assert.strictEqual(initial.status, "Draft") })\n');
    fs.writeFileSync(path.join(root, "test/draft.test.vibe"), citing("spec/index.md", "A new order is an empty draft") + 'import { assert, it } from "@effect/vitest"\nimport { initial } from "../gen/index.effect.vibe"\nit("a new order is a draft", () => { assert.strictEqual(initial.units, 0) })\n');
    const { failed, said, text } = await run(root);
    assert.deepEqual(failed, ["tests"], text);
    const line = read("test/app.test.vibe", root).split("\n").length - 1;
    assert.equal(said("tests", /^2 tests touch only generated code/)?.detail, `      test/app.test.vibe:${line}\n      test/draft.test.vibe: imports nothing but gen/ and test libraries`, text);
    assert.equal(said("tests", /^note: test\/app\.test\.vibe, test\/draft\.test\.vibe run in one runner, in one language/)?.ok, true, text);
  });

  test("a test that cites no story or rule is caught through aliases and namespaces; a citation on it, on the describe around it or in the file's header covers it", async () => {
    const reaching = 'import { assert, describe, it, it as scenario } from "@effect/vitest"\nimport * as suite from "@effect/vitest"\nimport { OrderBookMemory } from "../src/app.vibe"\n';
    const tests = "\n" + citing("spec/index.md", "Story: Cancel") + 'describe("cancelling", () => {\n  it("is covered by the describe", () => { assert.ok(OrderBookMemory) })\n})\n' + citing("spec/index.md", "Story: Check out") + 'it("is covered by its own", () => { assert.ok(OrderBookMemory) })\nit("cites nothing", () => { assert.ok(OrderBookMemory) })\nscenario("cites nothing through an alias", () => { assert.ok(OrderBookMemory) })\nsuite.it("cites nothing through a namespace", () => { assert.ok(OrderBookMemory) })\nsuite["it"]("cites nothing through element access", () => { assert.ok(OrderBookMemory) })\n';
    const [uncited, headed] = await Promise.all([
      run(copyOfProject("test/more.test.vibe", () => reaching + tests)),
      run(copyOfProject("test/more.test.vibe", () => citing("spec/index.md", "Story: Change my mind") + reaching + tests)),
    ]);
    assert.deepEqual(uncited.failed, ["tests"], uncited.text);
    const missing = (reaching + tests).split("\n").flatMap((line, i) => line.includes("cites nothing") ? [`      test/more.test.vibe:${i + 1}`] : []);
    assert.equal(uncited.said("tests", /^4 tests cite no story or rule/)?.detail, missing.join("\n"), uncited.text);
    assert.deepEqual(headed.failed, [], headed.text);
  });

  test("a test pass is remembered for its inputs; runner receipts allow reuse but a forged Turbo environment does not; unchecked specs are noted", async () => {
    const ran = path.join(scratch({}), "ran");
    const root = fixtures(["door"], (f) => Object.assign(f, {
      "package.json": JSON.stringify({ scripts: { test: `echo x >> ${JSON.stringify(ran)}` } }),
      "src/door.ts": "export const door = 1;\n",
    }));
    const runs = () => fs.readFileSync(ran, "utf8").length / 2;
    const first = await run(root);
    assert.ok(first.said("tests", /^pass\n$/) && first.said("tests", /^note: no test or driver checks spec\/door\.md;/), first.text);
    await run(root);
    assert.equal(runs(), 1);
    fs.writeFileSync(path.join(root, "src/door.ts"), "export const door = 2;\n");
    await run(root);
    assert.equal(runs(), 2);
    fs.mkdirSync(path.join(root, "test"));
    fs.writeFileSync(path.join(root, "test/door.test.ts"), 'import { test } from "node:test";\nimport { door } from "../src/door.ts";\ntest("uncited", () => { void door; });\n');
    const turbo = await exec(process.execPath, [path.join(project, "vibestack/spec.ts"), "check", "--json"], root, { ...process.env, TURBO_HASH: "1", npm_lifecycle_event: "check" });
    const said = JSON.parse(turbo.stdout).results.filter((r: Result) => r.stage === "tests").map((r: Result) => [r.ok, r.summary]);
    assert.deepEqual(said, [[false, "1 tests cite no story or rule: cite the one each serves, fold it into the journey that does, or propose deleting it"],
      [true, "note: no test or driver checks spec/door.md; a story that leaves the verified core needs a journey that cites it"], [true, "pass"]]);
    assert.equal(runs(), 3, "a Turbo environment value cannot claim that the test script ran");
    const receipt = testReceipt(root);
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.writeFileSync(receipt, JSON.stringify({ fingerprint: testInputs(root) }));
    const reused = await run(root);
    assert.ok(reused.said("tests", /^pass: the test runner recorded success for these inputs\n$/), reused.text);
    assert.equal(runs(), 3);
    fs.writeFileSync(path.join(root, "src/door.ts"), "export const door = 3;\n");
    await run(root);
    assert.equal(runs(), 4, "a receipt for older source cannot suppress the tests");
  });

  test("a rule whose prose or model changed names the code that cites it, for a person to read again", () => {
    const root = copyOfProject("spec/index.md", (s) => s.replace("### No more can be removed than the order holds\n", "$&\nNot one more.\n"));
    const shown = pending(root, readSpecs(root)[0]).filter((p) => p.cited).map(showPending);
    const line = read("spec/index.md", root).split("\n").indexOf("### No more can be removed than the order holds") + 1;
    assert.deepEqual(shown, [`spec/index.md:${line}  Story: Change my mind / No more can be removed than the order holds\n      prose changed: update the model to match, or confirm it already does\n      cited by test/app.test.vibe:18: read them again against it`]);
  });

  test("a shell written for a transition the spec has since renamed no longer fits the generated contract", async () => {
    const { said, next, text } = await run(copyOfProject("spec/index.md", (s) => s.replace(/\b(a|canA)ddItem\b/g, "$1ddItems")));
    assert.equal(said("types", /./)?.summary, "application does not fit the generated contract", text);
    assert.match(stripVTControlCharacters(text), /src\/demo\.vibe(?:\(\d+,\d+\):|:\d+:\d+ -) error TS2820: Type '"addItem"' is not assignable/);
    assert.match(next, /^types \(src\/ and test\/\) is the first ✗: update src\/ and test\/ to the generated contract/);
  });

  test("every generated module has an Effect adapter, which the compiler accepts inside gen/ with a shell that uses it, for a library, a machine built on it, one built on a machine, one with a sender and one with effects", async () => {
    const names = ["lamp", "lib", "mailer", "room", "shop", "vault"];
    const root = scratch({ ...Object.fromEntries(names.map((n) => [`spec/${n}.md`, read(`vibestack/fixtures/${n}.md`)])), "src/desk.vibe": `import { total } from "../gen/lib.effect.vibe"
import { Machine as Mailer, machine as mailer } from "../gen/mailer.effect.vibe"
import { add, apply, initial } from "../gen/shop.effect.vibe"
import { type NotASender, type Rejected, Machine as Vault, decodeSender, machine as vault } from "../gen/vault.effect.vibe"

/** The owner opens the vault, and whoever \`input\` names relabels it. */
export effect function relabelled(input: unknown, label: string): string!(NotASender | Rejected) {
  provide vault() {
    const held = try Vault
    try held.send({ type: "open" }, "Owner")
    return (try held.send({ type: "relabel", label }, try decodeSender(input))).label
  }
}

/** What sending \`n\` asks of the program, and how many were sent. */
export effect function posted(n: number) {
  provide mailer() {
    const held = try Mailer
    const did = try held.receive({ type: "send", n })
    return [did.out.length, (try held.get()).sent] as const
  }
}

/** A cart with one line, by the rules and by the transition itself, and what a library makes of it. */
export effect function filled(sku: string, qty: number) {
  const cart = try apply(initial, { type: "add", sku, qty })
  return [cart.count, add(initial, sku, qty).count, total([qty])] as const
}
` });
    assert.deepEqual(await genAll(root), ["_conformance.ts", "package.json", ...names.flatMap((n) => [`${n}.qnt`, `${n}.run.qnt`, `${n}.ts`, `${n}.effect.vibe`, ...(n === "lib" ? [] : [`${n}.conformance.ts`])])].sort());
    // gen/package.json names no package, so the compiler has no key to derive for a service: the adapter states its own (EK0903).
    assert.deepEqual(JSON.parse(read("gen/package.json", root)), { type: "module" });
    assert.match(read("gen/vault.effect.vibe", root), new RegExp(`^export service Machine \\{\\n  static readonly key = ${JSON.stringify(`${path.basename(root)}/spec/vault.md#Machine`).replace(/[./]/g, "\\$&")}$`, "m"));
    // A package without a name is told apart by where it sits in its workspace, or by its directory's name: never by
    // where the checkout is, so the same package generates the same text anywhere.
    const unnamed = async (dir: string, files: Record<string, string> = {}) => {
      const at = path.join(scratch({ ...files, [`${dir}/spec/counter.md`]: ruleSpec(COUNTER) }), dir);
      await genAll(at);
      return read("gen/counter.effect.vibe", at);
    };
    const [one, two, member] = [await unnamed("pkg"), await unnamed("pkg"), await unnamed("packages/x", { "pnpm-workspace.yaml": "" })];
    assert.equal(one, two);
    assert.match(one, /key = "pkg\/spec\/counter\.md#Machine"/);
    assert.match(member, /key = "packages\/x\/spec\/counter\.md#Machine"/);
    const compiled = await tool("vibelang", ["--noEmit", "-p", "."], root);
    assert.ok(compiled.ok, compiled.out);
    const counter = ruleSpec("pure val initial: int = 0\npure def add(n: int): int = n + 1");
    // Two packages may each have spec/index.md: the package's name is part of its machine's key.
    const named = (name: string) => scratch({ "package.json": JSON.stringify({ ...JSON.parse(PACKAGE["package.json"]), name }), "spec/index.md": counter, "src/.keep": "" });
    const first = named("first-machine"), second = named("second-machine");
    await Promise.all([genAll(first), genAll(second)]);
    fs.writeFileSync(path.join(first, "src/pair.vibe"), `import { Machine as First, machine as first } from "../gen/index.effect.vibe"
import { Machine as Second, machine as second } from ${JSON.stringify(path.relative(path.join(first, "src"), path.join(second, "gen/index.effect.vibe")).split(path.sep).join("/"))}
export effect function independent() {
  provide first(), second() {
    const a = try First
    const b = try Second
    try a.send({ type: "add" })
    return [try a.get(), try b.get()]
  }
}
`);
    const paired = await exec(process.execPath, ["--import", "vibelang/register", "--input-type=module", "-e", 'import assert from "node:assert/strict"; import { Effect } from "effect"; import { independent } from "./src/pair.vibe"; assert.deepEqual(await Effect.runPromise(independent()), [1, 0]);'], first);
    assert.equal(paired.status, 0, paired.stdout + paired.stderr);
    const isolated = scratch({ "package.json": PACKAGE["package.json"], "spec/index.md": ruleSpec(`type Item = { n: int }
type State = { item: Item }
type Result = { state: State, out: List[Item] }
pure val initial: State = { item: { n: 0 } }
pure val entryValues = Set({ n: 0 }, { n: 2 })
pure def canSetItem(s: State, entry: Item): bool = entry.n >= 0
pure def setItem(s: State, entry: Item): Result = { state: { item: entry }, out: List(entry) }`), "src/probe.vibe": `import { Machine, machine } from "../gen/index.effect.vibe"
export effect function probe() {
  const start = { item: { n: 0 } }
  provide machine(start) {
    start.item.n = 42
    const held = try Machine
    const first = try held.get()
    const before = first.item.n
    first.item.n = 43
    const event = { type: "setItem" as const, entry: { n: 2 } }
    const after = try held.send(event)
    after.state.item.n = 44
    after.out[0].n = 45
    event.entry.n = 46
    try Stream.runHead(Stream.map(held.changes, (state) => { state.item.n = 47; return state }))
    held.send({ type: "setItem", entry: { n: -1 } }) catch (error) => { error.state.item.n = 48 }
    return [before, (try held.get()).item.n]
  }
}
` });
    await genAll(isolated);
    const protectedState = await exec(process.execPath, ["--import", "vibelang/register", "--input-type=module", "-e", 'import assert from "node:assert/strict"; import { Effect } from "effect"; import { probe } from "./src/probe.vibe"; assert.deepEqual(await Effect.runPromise(probe()), [0, 2]);'], isolated);
    assert.equal(protectedState.status, 0, protectedState.stdout + protectedState.stderr);
  });

  test("a machine that binds a name of its Effect adapter is refused, and a library, which has no such names, may bind it", async () => {
    const { failed, said, text } = await run(oneRule("t", "A rule", "pure val initial: int = 0\npure def apply(n: int, k: int): int = n + k"));
    assert.deepEqual(failed, ["model"], text);
    assert.ok(said("model", /^spec\/t\.md is not a valid model\n\s+spec\/t\.md: `apply` is a name of the generated Effect adapter \(gen\/t\.effect\.vibe\); name the definition otherwise$/), text);
    const library = oneRule("t", "A rule", "pure def apply(n: int, k: int): int = n + k");
    await gen(library, parseSpec(library, "spec/t.md"));
    assert.match(read("gen/t.effect.vibe", library), /^export \{ apply \}$/m);
  });

  test("Markdown the tools would read differently from a viewer is refused or read as a viewer does", async () => {
    const cr = await failedStages("spec/index.md", (s) => s.replace("Every unit costs the same", "Every unit costs the same\rpure val sneaky = 1"));
    assert.deepEqual(cr, ["model"]);
    // A fence with an info string does not close a quint block, so what follows is still Quint (and here not valid Quint).
    const fence = await failedStages("spec/index.md", (s) => s.replace("pure val unitPrice = 5", "pure val unitPrice = 5\n```text\nnot quint"));
    assert.ok(fence.includes("model"), fence.join());
  });

  test("duplicate story headings are rejected instead of sharing review state", async () => {
    const text = ruleSpec("pure val first = 1", "First", "Duplicate") + ruleSpec("pure val second = 2", "Second").replace(/^# T\n/, "");
    const { said, text: result } = await run(scratch({ "spec/duplicate.md": text }));
    assert.equal(said("model", /duplicate story/)?.ok, false, result);
  });

  test("a story whose title starts another story's title still needs rules of its own", async () => {
    const story = "\n## Story: Wrap\n\n> As a shopper, I want my order wrapped.\n\n## Story: Wrap / gifts\n\n### Gifts are wrapped\n\n```quint\npure def lawWrapped(n: int): bool = true\n```\n";
    const { failed, said, text } = await run(copyOfProject("spec/index.md", (s) => s + story));
    assert.deepEqual(failed, ["review"], text);
    assert.ok(said("review", /  Story: Wrap\n\s+story has no rules/), text);
  });

  test("a machine whose state holds a library's type can be imported under a name", async () => {
    const root = scratch({
      "spec/lib.md": ruleSpec("type T = { n: int }\npure def lawZeroIsZero(k: int): bool = k * 0 == 0", "Library", "Library"),
      "spec/mach.md": ruleSpec('import lib.* from "./lib"\ntype St = { t: T }\npure val initial: St = { t: { n: 0 } }\npure def bump(s: St): St = { t: { n: s.t.n + 1 } }', "Machine", "Machine"),
      "spec/sys.md": ruleSpec('import mach as M from "./mach"\ntype Sys = { a: M::St }\npure val initial: Sys = { a: M::initial }\npure def go(s: Sys): Sys = { a: M::bump(s.a) }', "System", "System"),
    });
    const { failed, said, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
    assert.ok(said("proof", /^sys\.ts: all \d+ obligations proved/), text);
  });

  test("event weights, fairness and bounds name real events and rules and stay outside generated code; a weight repeats its event in the simulator's choice", async () => {
    const base = "type S = { n: int }\npure val initial: S = { n: 0 }\npure def add(s: S, k: int): S = { n: s.n + k }\npure def leadsToSome(s: S, later: S): bool = later.n >= s.n\n";
    const model = (quint: string) => { const root = oneRule("w", "Weights", base + quint); return gen(root, parseSpec(root, "spec/w.md")); };
    const cases: [string, RegExp][] = [
      ["pure val weight_nope = 2", /weight_nope .*no transition named nope/],
      ["pure val weight_add = 0", /weight_add .*a whole number from 1 to 100/],
      ['pure val fair_add = "always"', /fair_add .*"weak"/],
      ["pure val within_nope = 2", /within_nope .*no leadsTo rule named nope/],
      ["pure val within_leadsToSome = 0", /within_leadsToSome .*a whole number from 1 to 100/],
      ["pure val within_leadsToSome = 101", /within_leadsToSome .*a whole number from 1 to 100/],
      ["pure def leadsToOne(s: S): bool = true", /leadsToOne: a `leadsTo` rule takes a state and a later state/],
    ];
    for (const [quint, message] of cases) await assert.rejects(model(quint), message, quint);
    const weighted = await model('pure val weight_add = 3\npure val fair_add = "weak"\npure val within_leadsToSome = 2');
    assert.match(weighted.harness, /action step = any \{ add, add, add \}/);
    assert.deepEqual(weighted.within, new Map([["leadsToSome", 2]]));
    assert.doesNotMatch(weighted.ts + weighted.harness, /weight_|fair_|within_/);
    const lone = oneRule("f", "Fair", 'type S = { n: int }\npure val initial: S = { n: 0 }\npure def add(s: S): S = { n: s.n + 1 }\npure val fair_add = "weak"');
    await assert.rejects(gen(lone, parseSpec(lone, "spec/f.md")), /fairness matters only to `leadsTo` rules/);
  });

  test("a `leadsTo` rule is broken by a fair run that stops or loops, until the events it waits on are fair; std/net is imported, simulated and proved beside the spec", async () => {
    const ping = (edit: (s: string) => string = (s) => s) => fixtures(["ping"], (f) => { f["spec/ping.md"] = edit(f["spec/ping.md"]); });
    const [ok, weak, unfair] = await Promise.all([
      run(ping()),
      // A copy lost and sent again for ever is a fair loop unless delivery is strongly fair.
      run(ping((s) => s.replace('fair_deliver = "strong"', 'fair_deliver = "weak"'))),
      // With nothing fair, a run may stop as soon as the question is asked.
      run(ping((s) => s.replace(/pure val fair_\w+ = "\w+"\n/g, ""))),
    ]);
    assert.deepEqual(ok.failed, ["review"], ok.text);
    assert.ok(ok.said("always", /no fair run that stops or loops in \d+ of them breaks a `leadsTo` rule \([1-9]\d* loops found\)/), ok.text);
    assert.ok(ok.said("proof", /^net\.ts: all \d+ obligations proved/), ok.text);
    assert.ok(!ok.said("review", /^std\/net\.md:/), ok.text);
    assert.ok(weak.said("always", /a fair run breaks "Story: Ask until answered \/ A question asked is answered".*may repeat its loop for ever[\s\S]*the run goes round from here/), weak.text);
    assert.ok(unfair.said("always", /a fair run breaks .*may stop at the last state, since no fair event is possible there/), unfair.text);
  });

  test("a `leadsTo` rule with a bound is broken by a run that takes that many events without meeting it", async () => {
    const serve = (tick: string) => oneRule("serve", "Served at once", [
      "type S = { asked: bool, served: bool, n: int }",
      "pure val initial: S = { asked: false, served: false, n: 0 }",
      "pure def canAsk(s: S): bool = not(s.asked)",
      "pure def ask(s: S): S = { ...s, asked: true }",
      "pure def canServe(s: S): bool = s.asked and not(s.served)",
      "pure def serve(s: S): S = { ...s, served: true }",
      tick,
      "pure def tick(s: S): S = { ...s, n: s.n + 1 }",
      "pure def leadsToServed(s: S, later: S): bool = s.asked implies later.served",
      'pure val fair_serve = "weak"',
      "pure val within_leadsToServed = 1",
    ].join("\n"));
    // A clock that may tick between a question and its answer delays the answer past the bound.
    const [ok, late] = await Promise.all([run(serve("pure def canTick(s: S): bool = s.served or not(s.asked)")), run(serve(""))]);
    assert.equal(ok.said("always", /no rule broken/)?.ok, true, ok.text);
    assert.ok(late.said("always", /a run breaks "Story \/ Served at once" \(spec\/serve\.md:5\) within its bound \(`within_leadsToServed = 1`\)[\s\S]*ask .*<- leadsToServed is owed from here\n.*tick .*<- the bound runs out here/), late.text);
    const longer = (delay: number) => oneRule("longer", "A bounded wait", `pure val initial: int = 0\npure def tick(n: int): int = n + 1\npure def leadsToAhead(n: int, later: int): bool = later >= n + ${delay}\npure val fair_tick = "weak"\npure val within_leadsToAhead = 21`);
    const [onTime, tooLate] = await Promise.all([run(longer(21)), run(longer(22))]);
    assert.deepEqual(onTime.failed, ["review"], onTime.text);
    assert.ok(tooLate.said("always", /within its bound \(`within_leadsToAhead = 21`\)/), tooLate.text);
  });

  test("nested set samples stay bounded, an inner lambda may shadow a match binder, and forall and subseteq keep their meaning as quantifiers", async () => {
    // A set's `forall` and `subseteq` are printed negated (print.ts, SET_OPS): the laws are sampled, compared with Quint and proved.
    const quantifiers = "\npure def positive(x: int): bool = x > 0\npure def lawQuantifiers(xs: Set[int]): bool = xs.subseteq(xs) and (xs.forall(positive) or xs.exists(x => x <= 0)) and not(xs.exists(x => x > 0) and xs.forall(x => x <= 0))";
    const root = oneRule("nested", "Nested values", "type P = A({ xs: List[int] }) | B\npure def sum(p: P): int = match p { | A(x) => x.xs.foldl(0, (n, x) => n + x) | _ => 0 }\npure def lawSum(k: int): bool = sum(A({ xs: List(1, 2) })) == 3\npure def lawCount(xs: List[Set[int]]): bool = xs.length() >= 0\npure def zeros(n: int): Set[int] = Set(n * 0)\npure def lawZeros(n: int): bool = zeros(n).contains(0)" + quantifiers);
    const { failed, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
    const scoped = libAndUse(ruleSpec("pure val value = 1"), ruleSpec(`import lib.* from "./lib"
pure val own = 2
pure def echo(value: int): int = value
pure def echoLocal(n: int): int =
  val value = n
  value
pure def sum(xs: List[int]): int = xs.foldl(0, (acc, value) => acc + value)
pure def shadowOwn(own: int): int = own
pure def paramShadow(value: int): int =
  val value = 7
  value
pure def nestedShadow(value: int): int =
  val value = 7
  val value = 8
  value
pure def lawEcho(value: int): bool = echo(value) == value
pure def lawOwn(own: int): bool = shadowOwn(own) == own`));
    const checked = await run(scoped);
    assert.deepEqual(checked.failed, ["review"], checked.text);
    const domain = await import(path.join(scoped, "gen/use.ts"));
    assert.deepEqual([domain.echo(7), domain.echoLocal(8), domain.sum([2, 3]), domain.shadowOwn(9), domain.paramShadow(1), domain.nestedShadow(1)], [7, 8, 5, 9, 7, 8]);
  });

  test("a locally chosen enum keeps its Quint type in the generated proof", async () => {
    const root = oneRule("choice", "Choose", "type Choice = Left | Right\npure def use(c: Choice): int = if (c == Left) 1 else 2\npure def chosen(b: bool): int =\n  val c = if (b) Left else Right\n  use(c)\npure def lawChosen(b: bool): bool = chosen(b) == (if (b) 1 else 2)");
    const { failed, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
    const record = oneRule("recordLocal", "A local record keeps its value", "pure def value(n: int): int =\n  val box = { value: n }\n  box.value");
    await gen(record, parseSpec(record, "spec/recordLocal.md"));
    assert.equal((await import(path.join(record, "gen/recordLocal.ts"))).value(7), 7);
  });

  test("a transition and its guard bind a second state-shaped parameter identically during replay", async () => {
    const root = oneRule("copy", "Copy", "pure val initial: int = 0\npure def canCopy(n: int, source: int): bool = n <= source\npure def copy(n: int, source: int): int = source\npure def alwaysNonnegative(n: int): bool = n >= 0");
    const { failed, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
  });

  test("a law over a reachable state is checked beyond the initial state", async () => {
    const root = fixtures(["lamp"], (f) => { f["spec/lamp.md"] += `\n### No flips\n\n${F}quint\npure def lawZero(l: Lamp): bool = l.flips == 0\n${F}\n`; });
    const { said, text } = await run(root);
    assert.equal(said("always", /^the law .* is false/)?.ok, false, text);
    assert.ok(!text.includes("the simulator could not run"), text);
  });

  test("a quint block indented inside a list is still part of the model", async () => {
    const failed = await failedStages("spec/index.md", (s) => s + "\n### Nothing is ever fine\n\n- because:\n\n  ```quint\n  pure def alwaysBogus(o: Order): bool = false\n  ```\n");
    assert.ok(failed.includes("always"), failed.join());
  });

  test("lists, nested helpers, an imported library, laws, step rules and the proof ledger work together", async () => {
    const shop = (edit?: (files: Record<string, string>) => void) => fixtures(["lib", "shop"], edit);
    const plainRoot = shop();
    const recorded = shop((f) => { f["src/count.ts"] = 'import { type Cart } from "../gen/shop.ts";\n//@ pure\nexport function count(c: Cart): number {\n  //@ ensures \\result === c.count\n  return c.count;\n}\n'; });
    const [plain, recording, wrongStep, wrongLaw, importsMachine, circle] = await Promise.all([
      run(plainRoot),
      run(recorded, "unproved"),
      run(shop((f) => { f["spec/shop.md"] = f["spec/shop.md"].replace("count: c.count }", "count: c.count - 1 }"); })),
      run(shop((f) => { f["spec/lib.md"] = f["spec/lib.md"].replace("total(List(n)) == n", "total(List(n)) == n + 1"); })),
      run(shop((f) => { f["spec/other.md"] = ruleSpec('import shop.* from "./shop"\npure val two = 2', "Uses a machine", "Other", "Group"); })),
      run(shop((f) => { f["spec/lib.md"] = f["spec/lib.md"].replace("pure def total", 'import shop.* from "./shop"\npure def total'); })),
    ]);
    // The nested helpers (some inside some inside every) agree between Quint and TypeScript, and simulation passes.
    assert.deepEqual(plain.failed, ["proof", "review"], plain.text);
    assert.ok(plain.said("proof", /not proved/), plain.text);
    // `every` reaches Dafny as a quantifier over the members, as `some` does, not as Std.Collections.Seq.All (print.ts, LIST_HELPERS).
    assert.match(fs.readFileSync(path.join(plainRoot, "gen/proof/shop/shop.dfy"), "utf8"), /\n  !\(\(exists l :: l in c\.lines && !\(\(exists t :: t in l\.tags && \(exists m :: m in c\.lines/);
    // Once the unproved obligations are recorded, only the review is left.
    // Hand-written code proved against the shop says that it rests on what is simulated only there.
    assert.match(recording.said("proof", /^spec\/lock\.json: [1-9]\d* added, 0 removed\n/)?.detail ?? "", /^    \+ shop\.ts: /m, recording.text);
    const accepted = await run(recorded);
    assert.deepEqual(accepted.failed, ["review"], accepted.text);
    assert.ok(accepted.said("proof", /^src-count\.ts: all 1 obligations proved for all states and inputs, assuming the obligations that are simulated only \([^)]*\d+ of shop\.ts\)/), accepted.text);
    // A proof line that relies on what is simulated only lists it.
    assert.match(accepted.said("proof", /^shop\.ts: \d+ obligations, of which \d+ are simulated only \(accepted\)/)?.detail ?? "", /simulated only, accepted in spec\/lock\.json:\n\s+\w+: /, accepted.text);
    assert.match(accepted.said("proof", /^src-count\.ts: /)?.detail ?? "", /assumed from the module it is proved against, simulated only there:\n\s+(lib|shop)\.ts: \w+: /, accepted.text);
    // What was recorded is tied to the text it was recorded for: once the unit's text changes, it no longer counts.
    fs.appendFileSync(path.join(recorded, "spec/lib.md"), `\n### Two\n\n${F}quint\npure val two = 2\n${F}\n`);
    const moved = await run(recorded);
    assert.equal(moved.said("proof", /^shop\.ts: \d+ of \d+ obligations not proved; the \d+ accepted earlier were accepted for another text/)?.ok, false, moved.text);
    assert.equal(wrongStep.said("always", /^a step breaks/)?.ok, false, wrongStep.text);
    assert.equal(wrongLaw.said("always", /^the law .* is false for \{"n":/)?.ok, false, wrongLaw.text);
    assert.ok(importsMachine.said("model", /is imported under a name/), importsMachine.text);
    assert.ok(circle.said("model", /import each other in a circle/), circle.text);
  });

  test("list helpers are expanded into built-in folds, innermost first, without moving a line or touching strings and comments", () => {
    const out = expandListHelpers("pure def f(xs: List[T]): bool =\n  xs.every(t => t.ps.some(p =>\n    p == t.id))\n// xs.some(note in prose)");
    assert.equal(out.split("\n").length, 4);
    assert.ok(!/\.(every|some)\(/.test(out.split("\n").slice(0, 3).join("\n")), out);
    assert.match(out, /std_every_\d+ and/);
    assert.match(out, /std_some_\d+ or/);
    assert.match(out, /\/\/ xs\.some\(note in prose\)$/);
    const kept = expandListHelpers('pure val note = "xs.some(y)" // xs.every(z)\npure def f(xs: List[int]): bool = xs.some(x => x > 0)');
    assert.ok(kept.includes('"xs.some(y)" // xs.every(z)'), kept);
    assert.match(kept, /xs\.foldl\(false, \(std_some_\d+, x\)/);
    assert.throws(() => expandListHelpers("pure def f(xs: List[int]): bool = xs.every(x => x > 0 // oops"), /no closing parenthesis/);
  });

  test("a state whose stages carry different data, with match and sets, is simulated, replayed, fully proved and parsed", async () => {
    const root = fixtures(["parcel"]);
    const { failed, said, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
    assert.ok(said("proof", /^parcel\.ts: all \d+ obligations proved/), text);
    assert.match(fs.readFileSync(path.join(root, "gen/parcel.ts"), "utf8"), /\| \{ tag: "Shipped"; weight: number; labels: string\[\]; hops: number \}/);
    const parcel = await import(path.join(root, "gen/parcel.ts"));
    assert.deepEqual(parcel.parseState({ tag: "Packed", weight: 1, labels: ["fragile"] }), { tag: "Packed", weight: 1, labels: ["fragile"] });
    for (const x of [{ tag: "Packed", weight: 1, labels: ["a", "a"] }, { tag: "Lost", weight: 1 }, { tag: "Shipped", weight: 1, labels: [], hops: -1 }, { tag: "Gone" }])
      assert.equal(parcel.parseState(x), undefined, JSON.stringify(x));
  });

  test("a machine built from a component states and proves a rule that spans two of them", async () => {
    const { failed, said, text } = await run(fixtures(["account", "bank"]));
    assert.deepEqual(failed, ["review"], text);
    assert.ok(said("model", /^spec\/bank\.md: 2 transitions, 1 always, 1 step, 1 sometimes/), text);
  });

  test("a machine is simulated with the sample sets of the specs it imports", async () => {
    // Every amount the account offers is more than the bank's current account holds, so nothing can ever be saved.
    const { failed, said, text } = await run(fixtures(["account", "bank"], (f) => { f["spec/account.md"] = f["spec/account.md"].replace("type Account", "pure val amountValues = Set(7)\ntype Account"); }));
    assert.ok(failed.includes("sometimes"), text);
    assert.ok(said("sometimes", /\bsave in .* never happened/), text);
  });

  test("tables keyed by integers and variants, getOr, nthOr, removeAt, structural == and a mapped append are simulated, replayed and proved", async () => {
    const root = fixtures(["hall"]);
    const { failed, said, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
    assert.ok(said("proof", /^hall\.ts: all \d+ obligations proved/), text);
    const hall = await import(path.join(root, "gen/hall.ts"));
    // A seat equal to a booked one, though another object, is booked already.
    const booked = hall.step(hall.initial, { type: "book", row: 1, kind: "Adult" });
    assert.equal(hall.enabled(booked, { type: "book", row: 1, kind: "Adult" }), false);
    assert.deepEqual(hall.parseState(booked), { booked: [{ row: 1, kind: "Adult" }], byRow: { 1: 1 }, byKind: { Adult: 1 } });
    for (const x of [{ ...booked, byRow: { "01": 1 } }, { ...booked, byRow: { $1: 1 } }, { ...booked, byKind: { Senior: 1 } }])
      assert.equal(hall.parseState(x), undefined, JSON.stringify(x));
  });

  test("one machine uses another under a name, keeps its rules, and adds rules about the pair", async () => {
    const { failed, said, text } = await run(fixtures(["lamp", "room"]));
    assert.deepEqual(failed, ["review"], text);
    assert.ok(said("proof", /^room\.ts: all \d+ obligations proved/), text);
  });

  test("a spec that refines another is held to it on every step, and proved to be", async () => {
    const sw = (edit: (s: string) => string = (s) => s) => fixtures(["lamp", "switch"], (f) => { f["spec/switch.md"] = edit(f["spec/switch.md"]); });
    const [ok, uncounted, lit, started] = await Promise.all([
      sw(),
      sw((s) => s.replace("presses: s.presses + 1", "presses: s.presses")),
      sw((s) => s.replace("{ ...s, held: true }", "{ ...s, held: true, lit: true }")),
      sw((s) => s.replace("{ lit: false, presses: 0, held: false }", "{ lit: false, presses: 1, held: false }")),
    ].map((r) => run(r)));
    assert.deepEqual(ok.failed, ["review"], ok.text);
    assert.ok(ok.said("proof", /^switch\.ts: all \d+ obligations proved/), ok.text);
    assert.ok(uncounted.said("always", /\(spec\/switch\.md:\d+\) is not a step of L: it changes refinesL, but not as L::toggle would/), uncounted.text);
    assert.ok(lit.said("always", /\(spec\/switch\.md:\d+\) changes refinesL, but L has no transition press/), lit.text);
    assert.ok(started.said("always", /\(spec\/switch\.md:\d+\) does not map the initial state onto L::initial/), started.text);
  });

  test("a map is looked up safely, division and remainder agree with Quint for negative numbers, and the parsers admit only what fits", async () => {
    const root = fixtures(["stock"]);
    const { failed, said, text } = await run(root);
    assert.deepEqual(failed, ["proof", "review"], text);
    assert.ok(said("replay", /every law, and \d+ definitions/)?.ok, text);
    const proof = said("proof", /^stock\.ts:/);
    assert.ok(proof, text);
    assert.doesNotMatch(`${proof.summary}\n${proof.detail}`, /lawBoxesAndLooseMakeTheWhole/, "the division law is proved, so it is not listed as unproved");
    const stock = await import(path.join(root, "gen/stock.ts"));
    // A map key that every object has, a getter on an event, and an extra field are all harmless.
    const received = stock.step(stock.initial, stock.parseEvent({ type: "receive", sku: "constructor", qty: 1 }));
    assert.equal(stock.level(received, "constructor"), 1);
    assert.equal(stock.level(received, "toString"), 0);
    let reads = 0;
    assert.deepEqual(stock.parseEvent({ type: "receive", sku: "a", get qty() { return reads++ ? 1000 : 2; }, extra: 1 }), { type: "receive", sku: "a", qty: 2 });
    assert.equal(stock.parseEvent({ type: "receive", sku: "a", qty: 1.5 }), undefined);
    // parseState admits exactly a value with the state's shape that keeps every rule, as a fresh copy.
    const kept = { levels: { $a: 2 }, known: ["a"] };
    const parsed = stock.parseState(kept);
    assert.deepEqual(parsed, kept);
    assert.ok(parsed !== kept && parsed.levels !== kept.levels, "a fresh copy");
    assert.equal(stock.level(parsed, "a"), 2);
    const refused = [
      undefined, null, "state", [], { levels: { a: 2 }, known: ["a"] }, { levels: { $a: 1.5 }, known: ["a"] }, { levels: [], known: [] },
      { ...kept, extra: 1 }, { levels: { $a: -1 }, known: ["a"] }, // the last has the right shape but breaks alwaysNoLevelIsNegative
    ];
    for (const x of refused) assert.equal(stock.parseState(x), undefined, JSON.stringify(x));
  });

  test("replay notices TypeScript that disagrees with Quint, in a step or in a definition", async () => {
    const root = copyOfProject();
    const model = await gen(root, parseSpec(root, "spec/index.md"));
    const domain = await import(path.join(root, "gen/index.ts"));
    const trace = [{ state: domain.initial }, ...[{ type: "addItem", qty: 1 }, { type: "submit" }, { type: "pay", amount: 2 }]
      .map((event, i, all) => ({ event, state: all.slice(0, i + 1).reduce(domain.step, domain.initial) }))];
    replay(domain, trace);
    const broken = { ...domain, step: (s: any, e: any) => (e.type === "pay" ? { ...domain.step(s, e), status: "Paid" } : domain.step(s, e)) };
    assert.throws(() => replay(broken, trace), /TypeScript and Quint disagree/);
    assert.ok(model.evals.some((v) => v.name === "canSubmit"), "guards are among the definitions compared");
    const evaluated = (result: boolean) => [{ state: domain.initial }, { evaluated: { name: "canSubmit", picks: {}, result } }];
    replay(domain, evaluated(false), model);
    assert.throws(() => replay(domain, evaluated(true), model), /disagree on canSubmit/);
    assert.throws(() => replay({ ...domain, canSubmit: () => true }, evaluated(false), model), /disagree on canSubmit/);
  });

  test("a rule heading cannot become code", async () => {
    const { said, text } = await run(oneRule("counter", "A counter */ globalThis.INJECTED = true; /* starts at zero", "pure val initial: int = 0\npure def bump(n: int): int = n + 1"));
    assert.equal((globalThis as any).INJECTED, undefined, "the heading ran as code");
    assert.ok(said("replay", /agrees with Quint/)?.ok, text);
  });

  test("a proof cannot be forged from inside the project", async () => {
    const withFile = (file: string, text: string) => {
      const root = copyOfProject("spec/index.md", notInductive);
      fs.writeFileSync(path.join(root, file), text);
      return root;
    };
    const unproved = /^index\.ts: \d+ of \d+ obligations not proved/;
    const tsconfigured = withFile("tsconfig.json", `{"compilerOptions":{"noLib":true,"types":["missing"]},"files":["missing.ts"]}`);
    const lookalike = copyOfProject("src/ledger.ts", (s) => s.replace('"../gen/index.ts"', '"./index.ts"'));
    fs.writeFileSync(path.join(lookalike, "src/index.ts"), 'export * from "../gen/index.ts";\n');
    const [namesake, configured, ownConfig, sneaky, lying, disguised] = await Promise.all([
      run(withFile("src/index.ts", ONE)),
      run(withFile("lemmascript.json", `{"proof-dir":"proofs"}`)),
      run(tsconfigured),
      run(copyOfProject("src/ledger.ts", (s) => s.replace("return order.due - order.paid;", "/* x */ //@ assume false\n  return order.paid - order.due;"))),
      run(copyOfProject("src/ledger.ts", (s) => s.replace("\nexport function replay", '\n  import { owed } from "/tmp/lies.ts";\nexport function replay'))),
      run(lookalike),
    ]);
    // A file in src/ named after the spec does not take the place of the spec's own proof.
    assert.ok(namesake.said("proof", unproved), namesake.text);
    // A LemmaScript configuration in the project cannot point the proof at files someone could edit.
    assert.ok(configured.said("proof", unproved), configured.text);
    // Nor can the project's tsconfig.json add files, globals or options to the proof: each unit has its own.
    assert.ok(ownConfig.said("proof", unproved), ownConfig.text);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tsconfigured, "gen/proof/index/tsconfig.json"), "utf8")).files, ["index.ts"]);
    // An annotation that asks the prover for trust is refused wherever it sits on the line.
    assert.ok(sneaky.said("proof", /`\/\/@ assume` is not allowed/), sneaky.text);
    // So is an import of anything but a generated module, however it is indented, or of a look-alike of one.
    assert.ok(lying.said("proof", /may only import generated modules/), lying.text);
    assert.deepEqual(disguised.failed, ["proof"], disguised.text);
    assert.ok(disguised.said("proof", /may only import generated modules/), disguised.text);
  });

  test("a law that needs induction is proved by a proof file, and only then offered to the spec that imports it", async () => {
    const project = (edit: (f: Record<string, string>) => void = () => {}) => fixtures(["highest", "ticket"], edit);
    const root = project();
    const [bare, proved, unoffered, trusting] = await Promise.all([
      run(project((f) => { delete f["spec/highest.proof.dfy"]; delete f["spec/ticket.proof.dfy"]; f["spec/typo.proof.dfy"] = ""; })),
      run(root),
      run(project((f) => { delete f["spec/highest.proof.dfy"]; })),
      run(project((f) => { f["spec/highest.proof.dfy"] = f["spec/highest.proof.dfy"].replace("ProofLib.FoldLeftMax", "assume false;\n  ProofLib.FoldLeftMax"); })),
    ]);
    // Without a proof file the law is not proved, and a proof file that belongs to nothing is pointed out.
    assert.equal(bare.said("proof", /^highest\.ts: 1 of 1 obligations not proved/)?.ok, false, bare.text);
    assert.equal(bare.said("proof", /^spec\/typo\.proof\.dfy belongs to no proof unit/)?.ok, false, bare.text);
    // With both proof files, everything proves, and the final Dafny is there to read.
    assert.deepEqual(proved.failed, ["review"], proved.text);
    assert.ok(proved.said("proof", /^ticket\.ts: all 3 obligations proved/), proved.text);
    assert.match(fs.readFileSync(path.join(root, "gen/proof/ticket/ticket.dfy"), "utf8"), /lemma \{:axiom\} highest_lawTheHighestIsAtLeastTheStart_ensures/);
    // A law its own unit does not prove is not offered.
    assert.equal(unoffered.said("proof", /^ticket\.ts: Dafny could not check it[\s\S]*unresolved identifier: highest_lawTheHighestIsAtLeastTheStart_ensures/)?.ok, false, unoffered.text);
    // A proof file that asks for trust is refused, with its file and line.
    assert.equal(trusting.said("proof", /spec\/highest\.proof\.dfy:4: `assume` is not allowed/)?.ok, false, trusting.text);
  });

  test("what an imported machine's unit proved is offered to the importer's proof file, and only once it is proved", async () => {
    const project = (edit: (f: Record<string, string>) => void = () => {}) => fixtures(["highest", "ticket", "office"], edit);
    const [proved, unoffered] = await Promise.all([run(project()), run(project((f) => { delete f["spec/ticket.proof.dfy"]; }))]);
    assert.deepEqual(proved.failed, ["review"], proved.text);
    assert.ok(proved.said("proof", /^office\.ts: all \d+ obligations proved/), proved.text);
    // Without the ticket's proof file its transition is not proved, so it is not offered.
    assert.equal(unoffered.said("proof", /^office\.ts: Dafny could not check it[\s\S]*unresolved identifier: ticket_issue_ensures/)?.ok, false, unoffered.text);
    // Bump preserves the second invariant but breaks the first at an amount simulation does not sample.
    const mixedRoot = fixtures(["magic"], (f) => {
      f["spec/consumer.md"] = ruleSpec('import magic as M from "./magic"\npure def lawGood(k: int): bool = M::alwaysBumpsNonNegative(M::bump({ n: 0, m: 0 }, 777777))\npure def lawBad(k: int): bool = k == 777777 implies M::alwaysNonNegative(M::bump({ n: 0, m: 0 }, 777777))');
      f["spec/consumer.proof.dfy"] = ["Good", "Bad"].map((name) => `lemma law${name}_ensures(k: int)\n  ensures (law${name}(k) == true)\n{\n  magic_bump_ensures(magic_C(0, 0), 777777);\n}\n`).join("\n");
    });
    const mixed = await run(mixedRoot);
    const consumer = mixed.said("proof", /^consumer\.ts: 1 of 2 obligations not proved/);
    assert.equal(consumer?.ok, false, mixed.text);
    assert.match(consumer!.detail, /lawBad: /);
    assert.doesNotMatch(consumer!.detail, /lawGood: /);
  });

  test("a proof file may only add lemmas, and only bodies to the generated ones; a body is the brace group that ends a lemma, after a complete header", () => {
    const refused: [string, string, RegExp][] = [
      ["a block comment", "lemma A() { /* } */ }", /block comments are not allowed/],
      ["an @-attribute", "@Axiom\nlemma A() {}", /p\.dfy:1: `@` is not allowed/],
      ["the axiom attribute", "lemma {:axiom} A() ensures false {}", /the attribute \{:axiom\} is not allowed/],
      ["an attribute with spaces", "lemma A() { assert { : verify false } true; }", /the attribute \{:verify\} is not allowed/],
      ["a character literal", "lemma A() { var c := 'a'; }", /character literals are not allowed/],
      ["assume", "lemma A()\n  ensures false\n{\n  assume false;\n}", /p\.dfy:4: `assume` is not allowed/],
      ["a function", "function F(): int { 1 }", /`function` is not allowed/],
      ["a predicate", "lemma A() {}\npredicate P() { true }", /p\.dfy:2: `predicate` is not allowed/],
      ["an include", 'include "other.dfy"', /`include` is not allowed/],
      ["a module", "module M {}", /`module` is not allowed/],
      ["expect", "lemma A() { expect false; }", /`expect` is not allowed/],
      ["reads", "lemma A() reads {} {}", /`reads` is not allowed/],
      ["a lemma with no body", "lemma A() ensures false", /lemma A has no body/],
      ["an unclosed body", "lemma A() { if true { }", /unbalanced braces/],
      ["a brace that closes nothing", "lemma A() { } }", /this \} closes nothing/],
      ["anything else at the top level", "assert false;", /only `lemma` declarations/],
      ["a lemma declared twice", "lemma A() {}\nlemma A() {}", /declared twice/],
      ["a carriage return that would end a comment early", "lemma A() { // note\rassume false;\n}", /line breaks other than/],
      ["a string that is not closed", 'lemma A() { var s := "x; }', /not closed/],
      ["a NUL character", "lemma A() { }\0", /p\.dfy:1: NUL characters are not allowed/],
      ["decreases with a set display", "lemma Bad() ensures false decreases {0}\nlemma B() { Bad(); }", /p\.dfy:1: lemma Bad has no body/],
      ["ensures with a set display", "lemma Bad(x: int) ensures x in {1}", /p\.dfy:1: lemma Bad has no body/],
      ["a multiset display", "lemma Bad(x: int) ensures x in multiset{1}", /p\.dfy:1: lemma Bad has no body/],
      ["a body followed by more", "lemma A() { } ensures false", /p\.dfy:1: lemma A has no body/],
    ];
    for (const [what, text, message] of refused) assert.throws(() => parseProofFile(text, "p.dfy"), message, what);
    assert.equal(parseProofFile("lemma Ok(s: set<int>) ensures s == {} ==> |s| == 0 ensures 1 in {1} { assert true; }", "p.dfy")[0].body.trim(), "assert true;");
    assert.equal(parseProofFile("// a comment\nlemma A(xs: seq<int>)\n  ensures forall i {:trigger xs[i]} :: 0 <= i < |xs| ==> xs[i] == xs[i]\n{\n  reveal F();\n  calc { 1; 1; }\n  forall i | 0 <= i < |xs| ensures xs[i] == xs[i] {}\n  assert true by { var x := 1; if x > 0 { } match xs { case _ => } }\n}\n", "p.dfy").length, 1);

    const spliced = (text: string) => splice(GENERATED_F, { proof: { file: "p.dfy", text }, axioms: [] }).dfy;
    // A body goes inside the generated lemma; a helper is appended; nothing generated changes.
    const out = spliced("lemma f_ensures(x: int)\n  ensures (f(x) >= x)   // spacing and comments do not matter\n{\n  Helper(x);\n}\nlemma Helper(x: int) ensures f(x) == x { }\n");
    assert.ok(out.startsWith(GENERATED_F.replace("{\n}\n", "{\n  Helper(x);\n}\n")), out);
    assert.match(out, /lemma Helper\(x: int\)/);
    // A header that no longer matches the generated one is stale.
    assert.throws(() => spliced("lemma f_ensures(x: int)\n  requires x > 0\n  ensures (f(x) >= x)\n{\n}\n"), /p\.dfy:1: lemma f_ensures does not repeat its generated header, so it is refused as stale/);
    // A helper may not take a generated name, or the library's.
    assert.throws(() => spliced("lemma f(x: int) { }"), /p\.dfy:1: lemma f: the name is already declared/);
    assert.throws(() => spliced("lemma ProofLib() { }"), /the name is already declared/);
    // Of the library, only what the proof file calls goes in, with everything that uses in turn.
    const withLib = splice(GENERATED_F, { proof: { file: "p.dfy", text: "lemma H(xs: seq<int>) { ProofLib.FilterMember((x: int) => x > 0, xs, 1); }\n" }, axioms: [], lib: read("vibestack/proof/lib.dfy") }).dfy;
    assert.deepEqual([...withLib.slice(withLib.indexOf("module ProofLib")).matchAll(/^\s*(?:ghost )?(?:lemma|function|predicate) (\w+)/gm)].map((m) => m[1]), ["Filter", "FilterNil", "FilterCons", "FilterMember"]);
  });

  test("an obligation that fails is not assumed while the others are checked", async () => {
    const root = fixtures(["twins"]);
    const { said, text } = await run(root);
    // Verified whole first, then the definition that failed, every assertion isolated, then each postcondition alone.
    assert.match(fs.readFileSync(path.join(root, "gen/proof/twins.log"), "utf8"), /every assertion isolated[\s\S]*checked on its own/);
    const found = said("proof", /^twins\.ts: 3 of 4 obligations not proved/);
    assert.equal(found?.ok, false, text);
    assert.match(found!.detail, /alwaysBIsAtMostThreeOrNinetyNine/);
    // The tools' step body calls the transition's lemma, so step rests on what that lemma does not prove.
    assert.match(found!.detail, /step: inv\(step\(current, event\)\)   \[rests on bump: /);
  });

  test("verified code in a subdirectory of src is proved too", async () => {
    const root = copyOfProject("src/deep/owed.ts", () => 'import { type Order } from "../../gen/index.ts";\n//@ pure\nexport function owed(o: Order): number {\n  //@ ensures \\result > 0\n  return o.due - o.paid;\n}\n');
    const { failed } = await run(root);
    assert.deepEqual(failed, ["proof", "review"]); // and its contract is new
    fs.renameSync(path.join(root, "src/deep/owed.ts"), path.join(root, "src/deep/source.txt"));
    fs.symlinkSync("source.txt", path.join(root, "src/deep/owed.ts"));
    assert.deepEqual((await run(root)).failed, ["proof", "review"]);
  });

  test("hand-written logic that breaks its contract is caught by the proof", async () => {
    const failed = await failedStages("src/ledger.ts", (s) => s.replace("return order.due - order.paid;", "return order.paid - order.due;"));
    assert.deepEqual(failed, ["proof", "tests"]);
  });

  test("moving a line break so that a comment swallows half a guard is a change to the model", async () => {
    const failed = await failedStages("spec/index.md", (s) => s.replace("pure def canAddItem(o: Order, qty: int): bool =\n  o.status == Draft and qty > 0 and o.units + qty <= maxUnits",
      "pure def canAddItem(o: Order, qty: int): bool =\n  o.status == Draft and qty > 0 // and o.units + qty <= maxUnits"));
    assert.ok(failed.includes("review"), failed.join());
  });

  test("a comment in the Quint is reviewed, but the model it annotates is not simulated again", async () => {
    const root = copyOfProject("spec/index.md", (s) => s.replace("pure val unitPrice = 5", "pure val unitPrice = 5 /* euros */ // per unit"));
    const { failed, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
    assert.ok(!fs.existsSync(path.join(root, "gen/traces")), text);
  });

  test("init exposes every skill, preserves local instructions and refreshes its marked procedure", () => {
    const root = scratch({ "AGENTS.md": "mine\n", "package.json": `{"scripts":{"check":"mine"}}` });
    const added = init(root);
    const agents = path.join(root, "AGENTS.md");
    const expected = `mine\n\n<!-- vibestack:start -->\n${read("AGENTS.md").trim()}\n<!-- vibestack:end -->\n`;
    assert.equal(fs.readFileSync(agents, "utf8"), expected);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts, { check: "mine", dev: "spec studio", gen: "spec gen", accept: "spec accept", build: "vibelang", test: "vitest run" });
    assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), "gen/\n.spec-cache/\n.studio/\ndist/\n.vibe/\n");
    const skills = fs.readdirSync(path.join(project, ".claude/skills")).sort();
    for (const dir of [project, root]) {
      assert.deepEqual(fs.readdirSync(path.join(dir, ".agents/skills")).sort(), skills);
      for (const name of skills) {
        const source = `.claude/skills/${name}`;
        const link = path.join(dir, `.agents/skills/${name}`);
        assert.equal(path.isAbsolute(fs.readlinkSync(link)), false);
        assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(dir, source)));
        assert.equal(read(`.agents/skills/${name}/SKILL.md`, dir), read(`${source}/SKILL.md`));
      }
    }
    assert.ok(added.includes("tsconfig.json"), added.join());
    assert.match(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), /^@AGENTS\.md$/m);
    assert.deepEqual(init(root), []);
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "My existing instructions.\n");
    init(root);
    assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "My existing instructions.\n\n@AGENTS.md\n");
    assert.equal(fs.readFileSync(agents, "utf8"), expected);
    assert.deepEqual(init(root), []);
    fs.writeFileSync(path.join(root, ".claude/skills/sync/SKILL.md"), "My sync instructions.\n");
    const design = path.join(root, ".agents/skills/design");
    fs.unlinkSync(design);
    fs.mkdirSync(design);
    fs.writeFileSync(path.join(design, "SKILL.md"), "My design instructions.\n");
    assert.deepEqual(init(root), []);
    assert.equal(read(".agents/skills/sync/SKILL.md", root), "My sync instructions.\n");
    assert.equal(read(".agents/skills/design/SKILL.md", root), "My design instructions.\n");
    for (const marker of ["onespec", "vibespec", "vibestack"]) {
      fs.writeFileSync(agents, `before\r\n<!-- ${marker}:start -->\r\nold instructions\r\n<!-- ${marker}:end -->\r\nafter\r\n`);
      init(root);
      assert.equal(fs.readFileSync(agents, "utf8"), `before\r\n<!-- vibestack:start -->\r\n${read("AGENTS.md").trim().replace(/\r?\n/g, "\r\n")}\r\n<!-- vibestack:end -->\r\nafter\r\n`);
      assert.deepEqual(init(root), []);
    }
    for (const invalid of [
      "<!-- vibestack:start -->\nincomplete\n",
      "<!-- vibestack:end -->\n<!-- vibestack:start -->\n",
      "<!-- vibestack:start -->\n<!-- vibestack:end -->\n<!-- vibestack:start -->\n<!-- vibestack:end -->\n",
    ]) {
      fs.writeFileSync(agents, invalid);
      assert.throws(() => init(root), /repair.*markers/);
      assert.equal(fs.readFileSync(agents, "utf8"), invalid);
    }
  });

  test("init sets a package up for a VibeLang shell: compiler and test runner configuration, scripts, the pinned toolchain with one Effect; what the package already has is kept, and a second run adds nothing", () => {
    const json = (root: string, file: string) => JSON.parse(read(file, root));
    const pins: Record<string, string> = { ...json(project, "package.json").dependencies, ...json(project, "package.json").devDependencies };
    const pinned = (...names: string[]) => Object.fromEntries(names.map((n) => [n, pins[n]]));
    const [runtime, tooling] = [["effect", "@effect/platform-node", "vibelang-runtime"], ["vibelang", "vibelang-vite", "vite", "vitest", "@effect/vitest", "@types/node"]];
    // VibeLang's packages move together, and with one version of Effect: each is pinned exactly.
    for (const name of [...runtime, ...tooling].filter((n) => n !== "@types/node")) assert.match(pins[name], /^\d+\.\d+\.\d+$/, name);
    // A workspace's `catalog:` means nothing in the package `init` writes it into.
    assert.match(pins["@types/node"], /^\^\d+\.\d+\.\d+$/);
    const one = { "@effect/platform-node-shared": pins["@effect/platform-node"] };
    const scripts = { dev: "spec studio", check: "spec check", gen: "spec gen", accept: "spec accept", build: "vibelang", test: "vitest run" };

    const fresh = scratch({ "package.json": '{"name":"fresh"}' });
    assert.deepEqual(init(fresh), [".claude/skills/sync/SKILL.md", ".agents/skills/sync", ".claude/skills/design/SKILL.md", ".agents/skills/design", ".claude/skills/shell/SKILL.md", ".agents/skills/shell", ".claude/skills/prove/SKILL.md", ".agents/skills/prove", "SPEC.md", "AGENTS.md (Vibestack instructions)", "CLAUDE.md (imports AGENTS.md)",
      "tsconfig.json", "vitest.config.ts", "spec/index.md", ".gitignore", "package.json scripts: dev, check, gen, accept, build, test",
      `package.json VibeLang toolchain: ${[...runtime, ...tooling].join(", ")} (run your package manager's install)`, "package.json packageManager: pnpm@10.24.0", "package.json engines.node: >=26", 'package.json "type": "module"']);
    assert.deepEqual(json(fresh, "tsconfig.json"), {
      compilerOptions: { target: "es2023", module: "nodenext", strict: true, skipLibCheck: true, types: ["node"], rootDir: ".", rootDirs: [".", ".vibe/declarations"], outDir: "dist", noEmitOnError: true, rewriteRelativeImportExtensions: true },
      include: ["src", "test", "gen/*.ts", "gen/*.vibe"], vibe: { sidecarDir: ".vibe/declarations" },
    });
    assert.equal(read("vitest.config.ts", fresh), 'import { project } from "vibestack/testing/vitest";\n\nexport default project({ root: import.meta.dirname });\n');
    assert.equal(read(".gitignore", fresh), "gen/\n.spec-cache/\n.studio/\ndist/\n.vibe/\n");
    assert.deepEqual(json(fresh, "package.json"), {
      name: "fresh", type: "module", packageManager: "pnpm@10.24.0", scripts, engines: { node: ">=26" },
      dependencies: pinned(...runtime), devDependencies: pinned(...tooling), pnpm: { overrides: one },
    });
    assert.ok(Object.values({ ...json(fresh, "package.json").dependencies, ...json(fresh, "package.json").devDependencies }).every((version) => typeof version === "string" && !/^(catalog|workspace):/.test(version)));
    assert.deepEqual(init(fresh), []);

    // The placeholder `npm init` writes is no test script; a script, a dependency, an override or an ignored path already there stays.
    const own = { name: "own", type: "module", scripts: { build: "mine", test: 'echo "Error: no test specified" && exit 1' }, engines: { node: ">=26" },
      dependencies: { effect: "mine" }, devDependencies: { vitest: "mine" }, overrides: { "@effect/platform-node-shared": "mine" }, pnpm: { overrides: { other: "mine" } } };
    const kept = scratch({ "package.json": JSON.stringify(own), "tsconfig.json": "{}\n", "vitest.config.ts": "export default {};\n", ".gitignore": "dist/\n" });
    const added = init(kept);
    assert.deepEqual(added.filter((a) => /^(package\.json|tsconfig|vitest|\.gitignore)/.test(a)), [".gitignore", "package.json scripts: dev, check, gen, accept, test",
      `package.json VibeLang toolchain: ${[...runtime, ...tooling].filter((n) => n !== "effect" && n !== "vitest").join(", ")} (run your package manager's install)`, "package.json packageManager: pnpm@10.24.0"]);
    assert.deepEqual([read("tsconfig.json", kept), read("vitest.config.ts", kept), read(".gitignore", kept)], ["{}\n", "export default {};\n", "dist/\ngen/\n.spec-cache/\n.studio/\n.vibe/\n"]);
    assert.deepEqual(json(kept, "package.json"), {
      ...own, packageManager: "pnpm@10.24.0", scripts: { ...scripts, build: "mine" }, dependencies: { ...pinned(...runtime), effect: "mine" }, devDependencies: { ...pinned(...tooling), vitest: "mine" },
      pnpm: { overrides: { ...one, other: "mine" } },
    });
    assert.deepEqual(init(kept), []);
  });

  test("nested specs link to children and reuse a machine through its directory index", async () => {
    const root = scratch({
      "spec/index.md": "# Home\n\n[Room](./rooms/)\n[Other lamp](./other/light/index.md)\n",
      "spec/rooms/index.md": read("vibestack/fixtures/room.md").replace('import lamp as L from "./lamp"', 'import /* from "wrong" */ lamp\n  from\n  "./light"').replaceAll("L::", "lamp::"),
      "spec/rooms/light/index.md": read("vibestack/fixtures/lamp.md"),
      "spec/rooms/light/index.proof.dfy": "",
      "spec/other/light/index.md": read("vibestack/fixtures/lamp.md"),
      "src/app.ts": `// ${"spec/rooms/index.md"}, ${JSON.stringify("Story: Light a room")}\nexport { initial, step } from "../gen/rooms.ts";\n`,
    });
    const specs = readSpecs(root);
    assert.deepEqual(specs.find((s) => s.name === "index")?.links, ["spec/rooms/index.md", "spec/other/light/index.md"]);
    assert.deepEqual(specs.find((s) => s.name === "rooms")?.imports, ["rooms__light"]);
    assert.equal(specs.find((s) => s.name === "rooms")?.uses[0].alias, "lamp");
    assert.deepEqual(danglingCitations(root, specs), []);
    const first = await run(root, "reviews");
    assert.deepEqual(first.failed, [], first.text);
    assert.ok(first.said("proof", /^rooms\.ts: all \d+ obligations proved/), first.text);
    const room = await import(path.join(root, "gen/rooms.ts"));
    const lit = room.step(room.step(room.initial, { type: "toggleLeft" }), { type: "toggleRight" });
    assert.equal(room.sometimesFullyLit(lit), true);
    assert.equal(room.inv(lit), true);
    assert.ok(fs.existsSync(path.join(root, "gen/other__light.ts")));
    assert.match(read("gen/rooms.conformance.ts", root), /^export type Driver<V = State> = Reaching<Event, V>;$/m);
    fs.appendFileSync(path.join(root, "spec/rooms/light/index.md"), `\n${F}quint\npure val label = "lamp"\n${F}\n`);
    const changed = readSpecs(root);
    assert.ok(pending(root, changed.find((s) => s.name === "rooms")!, changed).some((p) => p.note?.includes("spec/rooms/light/index.md")));
  });

  test("one spec tree: the package a spec directory names gets its modules and their imports in its own gen/, and the root's check runs its types, tests, traces, proofs and contract review under its path; an area without a package, and a package with a spec/ of its own, get none of it", async () => {
    const cite = `// ${"spec/app/index.md"}, "Count to the limit"\n`;
    const root = scratch({
      "spec/index.md": "# Product\n",
      "spec/app/index.md": ruleSpec(`import limits.* from "../shared/limits"\n${COUNTER.replaceAll("2", "limit")}`, "Count to the limit"),
      "spec/shared/limits.md": ruleSpec("pure val limit = 2", "The limit"),
      "spec/area/index.md": ruleSpec("pure val unowned = 1", "An area"),
      "spec/own/index.md": ruleSpec("pure val theirs = 1", "Theirs"),
      "apps/own/package.json": "{}",
      "apps/own/spec/index.md": "",
      "apps/app/package.json": JSON.stringify({ name: "@scratch/app", type: "module", scripts: { test: "node --test test/*.test.ts", "driver:app": `${JSON.stringify(process.execPath)} driver.mjs` } }),
      "apps/app/tsconfig.json": PACKAGE["tsconfig.json"],
      "apps/app/src/one.ts": ONE,
      // The application: a counter of its own for each key, which stops at `limit`.
      "apps/app/src/counter.ts": 'export function counter(limit = 2) {\n  const counts = new Map<string, number>();\n  return {\n    reset: () => counts.clear(),\n    dispatch: (key: string) => { const n = counts.get(key) ?? 0; if (n >= limit) return "refused" as const; counts.set(key, n + 1); return "accepted" as const; },\n    observe: (key: string) => counts.get(key) ?? 0,\n  };\n}\n',
      "apps/app/test/app.test.ts": `${cite}import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { counter } from "../src/counter.ts";\ntest("Count to the limit", () => { const c = counter(); for (const _ of [1, 2, 3]) c.dispatch("a"); assert.equal(c.observe("a"), 2); });\n`,
      // The traces stage runs it in the owner, against the spec, with the events the root's check found.
      "apps/app/test/drivers/app.ts": 'import type { Driver } from "../../gen/app.conformance.ts";\nimport { counter } from "../../src/counter.ts";\nexport const driver: Driver = counter();\n',
      "apps/app/driver.mjs": 'import fs from "node:fs"; import readline from "node:readline"; let n=0; for await (const line of readline.createInterface({input:process.stdin})) { if (!JSON.parse(line).event) n=0; else if (n<2) n++; console.log(JSON.stringify({state:n+(fs.existsSync("offset")?1:0)})); }',
    });
    fs.symlinkSync(nodeModules, path.join(root, "node_modules"), "dir");
    const first = await run(root, "reviews");
    assert.deepEqual(first.failed, [], first.text);
    // Beside them, the compiler leaves its declarations of the adapters.
    assert.deepEqual(fs.readdirSync(path.join(root, "apps/app/gen")).filter((f) => !f.endsWith(".d.ts")).sort(),
      ["_conformance.ts", "app.conformance.ts", "app.effect.vibe", "app.ts", "package.json", "shared__limits.effect.vibe", "shared__limits.ts"]);
    // The service runs in the owner, so its key carries the owner's name; the root's copy carries the root's.
    assert.match(read("apps/app/gen/app.effect.vibe", root), /key = "@scratch\/app\/spec\/app\/index\.md#Machine"/);
    assert.match(read("gen/app.effect.vibe", root), new RegExp(`key = "${path.basename(root)}/spec/app/index\\.md#Machine"`));
    assert.ok(["area.ts", "own.ts", "app.ts"].every((f) => fs.existsSync(path.join(root, "gen", f))) && !fs.existsSync(path.join(root, "apps/own/gen")));
    const normal = profile("normal");
    for (const [stage, said] of [["types", /^apps\/app: application typechecks/], ["tests", /^apps\/app: pass/], ["traces", /^apps\/app: script driver:app: simulated states and refused events agree with spec\/app\/index\.md/],
      ["traces", new RegExp(`^apps/app: test/drivers/app\\.ts: ${normal.runs} walks of seed ${normal.seed} agree with spec/app/index\\.md`)],
      ["proof", /^apps-app-src-one\.ts: all 1 obligations proved/], ["review", /^apps\/app\/src\/: recorded as reconciled: apps\/app\/src\/one\.ts/]] as const)
      assert.ok(first.said(stage, said), `${stage}\n${first.text}`);
    assert.deepEqual(Object.keys(JSON.parse(read("spec/lock.json", root)).contracts), ["apps/app/src/one.ts"]);
    assert.ok(!/apps\/own/.test(first.text), first.text);

    /** A copy of the tree with one file changed, and what the root's check says of it. */
    const copied = (file: string, text: string) => {
      const copy = scratch({});
      fs.cpSync(root, copy, { recursive: true });
      fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
      fs.writeFileSync(path.join(copy, file), text);
      return copy;
    };
    const broken = (file: string, text: string) => run(copied(file, text));
    const leaking = copied("apps/app/test/drivers/app.ts", read("apps/app/test/drivers/app.ts", root).replace("counter()", "counter(3)"));
    const [recursing, mistyped, failing, departing, cited, contract, driven, outgrown] = await Promise.all([
      // An owner's test script that checks the root would check itself.
      broken("apps/app/package.json", JSON.stringify({ name: "@scratch/app", type: "module", packageManager: JSON.parse(PACKAGE["package.json"]).packageManager, scripts: { test: `node ${JSON.stringify(path.join(project, "vibestack/spec.ts"))} check ../..` } })),
      broken("apps/app/src/wrong.ts", 'export const wrong: number = "x";\n'),
      broken("apps/app/test/never.test.ts", `${cite}import { test } from "node:test";\nimport { counter } from "../src/counter.ts";\ntest("never holds", () => { counter(); throw new Error("no"); });\n`),
      // The owner's driver runs its application against the spec, in the owner.
      run(leaking),
      broken("spec/app/index.md", read("spec/app/index.md", root).replace("Count to the limit", "Count up")),
      broken("apps/app/src/one.ts", ONE.replace("=== 1", ">= 1")),
      broken("apps/app/offset", ""),
      // A saved trace with an event the spec no longer has is not the application departing.
      broken("apps/app/test/counterexamples/app/gone.json", JSON.stringify({ trace: [["a", { type: "gone" }]] })),
    ]);
    const says = (found: Awaited<ReturnType<typeof run>>, stages: Result["stage"][], stage: Result["stage"], pattern: RegExp) => {
      assert.deepEqual(found.failed, stages, found.text);
      assert.ok(found.said(stage, pattern), found.text);
    };
    says(recursing, ["tests"], "tests", /^apps\/app: fail\n[\s\S]*a test script cannot run spec check or accept: the check already runs the tests/);
    says(mistyped, ["types"], "types", /^apps\/app: application does not fit the generated contract/);
    assert.match(stripVTControlCharacters(mistyped.text), /src\/wrong\.ts(?:\(1,14\):|:1:14 -) error TS2322: Type 'string' is not assignable to type 'number'/);
    says(failing, ["tests"], "tests", /^apps\/app: fail\n[\s\S]*never holds/);
    // The disagreement is saved, shrunk, in the owner, and replayed first from then on.
    says(departing, ["traces"], "traces", /^apps\/app: test\/drivers\/app\.ts: the program departs from the spec\n[\s\S]*conformance to spec\/app\/index\.md: (journey|walk)[\s\S]*Saved as test\/counterexamples\/app\/[0-9a-f]{12}\.json, which/);
    const [saved, ...more] = fs.readdirSync(path.join(leaking, "apps/app/test/counterexamples/app"));
    assert.deepEqual(more, []);
    assert.match(departing.next, new RegExp(`^traces \\(apps/app\\) is the first ✗: it saved the counterexample test/counterexamples/app/${saved}\\. Decide which side is wrong`));
    says(await run(leaking), ["traces"], "traces", new RegExp(`conformance to spec/app/index\\.md: test/counterexamples/app/${saved}, replayed`));
    assert.deepEqual(fs.readdirSync(path.join(leaking, "apps/app/test/counterexamples/app")), [saved]);
    says(outgrown, ["traces"], "traces", /^apps\/app: test\/drivers\/app\.ts: the run did not get as far as comparing\n +the spec has outgrown test\/counterexamples\/app\/gone\.json: \{"type":"gone"\}/);
    // A citation is read from the root, and its failure is the owner's alone.
    says(cited, ["tests", "review"], "tests", /^apps\/app: 1 citations name no story or rule of the spec\n +apps\/app\/test\/app\.test\.ts:1  spec\/app\/index\.md, "Count to the limit"$/);
    assert.equal(cited.text.match(/^✗ tests/gm)?.length, 1, cited.text);
    says(contract, ["review"], "review", /^apps\/app\/src\/: 1 contract\(s\) to reconcile[\s\S]*apps\/app\/src\/one\.ts\n +contract changed/);
    says(driven, ["traces"], "traces", /^apps\/app: script driver:app: the program departs from the spec\n[\s\S]*reset/);
    // Every spec a package's test checks is cited by it; the root has no src/ for an area without a package to shell.
    assert.ok(!/no test or driver checks/.test(first.text), first.text);
    // A rule whose meaning moved names the tests that cite it, in whichever package they are.
    const moved = copied("spec/app/index.md", read("spec/app/index.md", root).replace("### Count to the limit\n", "### Count to the limit\n\nNever past it.\n"));
    assert.deepEqual(pending(moved, parseSpec(moved, "spec/app/index.md")).map((p) => p.cited), [["apps/app/test/app.test.ts:1"]]);
  });

  test("nested spec paths refuse missing links, escaped targets, duplicate modules, cycles and symlinks", () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ "spec/index.md": "[Missing](./missing/)\n" }, /no spec at this path/],
      [{ "spec/index.md": "[Outside](../outside.md)\n", "outside.md": "" }, /stay within spec/],
      [{ "spec/index.md": "[Outside](..%2Foutside.md)\n", "outside.md": "" }, /stay within spec/],
      [{ "spec/index.md": "", "spec/room.md": "", "spec/room/index.md": "" }, /same module name/],
      [{ "spec/index.md": "", "spec/a/index.md": ruleSpec('import b.* from "../b"', "Import", "A"),
        "spec/b/index.md": ruleSpec('import a.* from "../a"', "Import", "B") }, /circle/],
    ];
    for (const [files, error] of cases) assert.throws(() => readSpecs(scratch(files)), error);
    const root = scratch({ "spec/index.md": "", "outside.md": "" });
    fs.symlinkSync(path.join(root, "outside.md"), path.join(root, "spec/linked.md"));
    assert.throws(() => readSpecs(root), /symbolic links/);
  });

  test("one lock preserves migrated reviews, contracts and proof acceptance and records deleted specs", async () => {
    const root = fixtures(["door"]);
    for (const spec of readSpecs(root)) acceptReviews(root, spec);
    const proof = { door: { text: "previously-reviewed", unproved: ["an obligation"] } };
    writeLedger(root, proof);
    const lockPath = path.join(root, "spec/lock.json");
    const before = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    before.contracts["src/old.ts"] = "old-contract";
    fs.writeFileSync(path.join(root, "spec/door.lock.json"), JSON.stringify(before.specs["spec/door.md"]));
    fs.writeFileSync(path.join(root, "spec/src.lock.json"), JSON.stringify(before.contracts));
    fs.writeFileSync(path.join(root, "spec/unproved.lock.json"), JSON.stringify(before.unproved));
    fs.rmSync(lockPath);
    assert.deepEqual(migrateLocks(root), ["spec/door.lock.json", "spec/src.lock.json", "spec/unproved.lock.json"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")), before);
    assert.deepEqual(readLedger(root), proof);
    assert.deepEqual(pending(root, readSpecs(root)[0]), []);
    assert.equal(fs.existsSync(path.join(root, "spec/door.lock.json")), false);
    fs.rmSync(path.join(root, "spec/door.md"));
    fs.writeFileSync(path.join(root, "spec/index.md"), "");
    assert.deepEqual(pendingSpecs(root, readSpecs(root)).map((p) => p.where), ["spec/door.md"]);
    const removed = await run(root, "reviews");
    assert.deepEqual(removed.failed, [], removed.text);
    const after = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.deepEqual(Object.keys(after.specs), ["spec/index.md"]);
    assert.deepEqual(pendingSpecs(root, readSpecs(root)), []);
    assert.deepEqual(after.contracts, {});
    assert.deepEqual(after.unproved, proof);
    fs.mkdirSync(path.join(root, "spec/child"));
    fs.writeFileSync(path.join(root, "spec/child/index.md"), "");
    fs.writeFileSync(path.join(root, "spec/index.md"), "# Home\n\n[Child](./child/)\n");
    assert.deepEqual((await run(root, "reviews")).failed, []);
    fs.writeFileSync(path.join(root, "spec/index.md"), "# Home\n\n[Open child](./child/)\n");
    const linked = readSpecs(root);
    assert.ok(pending(root, linked.find((s) => s.name === "index")!, linked).some((p) => p.status === "document changed"));
    assert.deepEqual((await run(root, "reviews")).failed, []);
    assert.deepEqual(pending(root, readSpecs(root).find((s) => s.name === "index")!), []);
  });

  test("malformed unified review records fail before checks can accept them", async () => {
    const root = scratch({ "spec/index.md": "", "spec/lock.json": JSON.stringify({ version: 1, specs: { "spec/index.md": { invalid: false } }, contracts: {}, unproved: {} }) });
    const before = fs.readFileSync(path.join(root, "spec/lock.json"), "utf8");
    const result = await run(root, "reviews");
    assert.deepEqual(result.failed, ["model"], result.text);
    assert.match(result.text, /invalid review records/);
    assert.equal(fs.readFileSync(path.join(root, "spec/lock.json"), "utf8"), before);
  });

  test("the package's own test script is what runs, never the check itself, and is added where test/ has none; a citation of a heading the spec does not have is caught, in a .vibe file as in a test, and never in what the compiler wrote for one", async () => {
    // The manifest keeps its name: the compiler derives the key of a service in src/ from it.
    const manifest = (scripts: Record<string, string>) => JSON.stringify({ ...JSON.parse(PACKAGE["package.json"]), scripts });
    const root = copyOfProject("package.json", () => manifest({ test: `node ${JSON.stringify(path.join(project, "vibestack/spec.ts"))} check` }));
    const again = await run(root);
    assert.deepEqual(again.failed, ["tests"], again.text);
    assert.ok(again.said("tests", /a test script cannot run spec check or accept: the check already runs the tests/), again.text);
    // A test script may check another project, as a tool's journey tests do: only its own project's lock is held.
    const other = fixtures(["door"]);
    fs.writeFileSync(path.join(root, "package.json"), manifest({ test: `cd ${JSON.stringify(other)} && node ${JSON.stringify(path.join(project, "vibestack/spec.ts"))} check --json > /dev/null; test -f gen/door.ts` }));
    const elsewhere = await run(root);
    assert.ok(elsewhere.said("tests", /^pass/), elsewhere.text);
    fs.writeFileSync(path.join(root, "package.json"), manifest({}));
    const cite = (heading: string) => `// spec/index.md, ${JSON.stringify(heading)}\n`;
    const cites = ["Story: Check out", "Only a non-empty draft can be submitted", "Refunds are instant"].map(cite).join("");
    fs.mkdirSync(path.join(root, "test/journeys"), { recursive: true });
    fs.writeFileSync(path.join(root, "test/journeys/checkout.test.ts"), `import { assert, it } from "@effect/vitest";\nimport { noted } from "../../src/notes.vibe";\n\n${cites}it("a journey", () => assert.ok(noted));\n`);
    fs.writeFileSync(path.join(root, "src/notes.vibe"), `${cite("Story: Check out")}${cite("Refunds are final")}export const noted = true\n`);
    // What the compiler writes for notes.vibe is its output, not the package's code, wherever it lands.
    fs.writeFileSync(path.join(root, "src/notes.d.vibe.ts"), `${cite("Refunds are final")}export declare const noted: boolean;\n`);
    const dangling = [["src/notes.vibe:2", "Refunds are final"], ["test/journeys/checkout.test.ts:6", "Refunds are instant"]].map(([at, heading]) => `${at}  ${cite(heading).slice(3, -1)}`);
    assert.deepEqual(danglingCitations(root, readSpecs(root)), dangling);
    const { failed, text, said } = await run(root);
    assert.deepEqual(failed, ["tests"], text);
    assert.equal(said("tests", /^2 citations name no story or rule of the spec\n/)?.detail, dangling.map((d) => `      ${d}`).join("\n"), text);
    // The package keeps its own vitest.config.ts.
    assert.ok(said("tests", /^test\/ had nothing to run it: added "test": "vitest run" to package\.json, as `spec init` does\n$/), text);
    assert.deepEqual(packageScripts(root), { test: "vitest run" });
    assert.ok(said("tests", /^pass\n$/), text);
  });

  test("a driver reaches the application: it imports gen/ only as types, it is sent malformed input where it can receive it, and a shell without one is given one to fill in", async () => {
    const typed = 'import type { Driver } from "../../gen/index.conformance.ts";\n';
    const oracleRoot = copyOfProject("test/drivers/index.ts", (s) => s.replace(typed, `${typed}import { initial as start } from "../../gen/index.ts";\nimport { type Event, step as advance } from "../../gen/index.effect.vibe";\nexport type { Order } from "../../gen/index.effect.vibe";\nexport { step } from "../../gen/index.ts";\nimport {} from "../../gen/index.ts";\nexport {} from "../../gen/index.ts";\nconst folder = "../../gen";\nconst literal = import(\`../../gen/index.ts\`);\nconst interpolated = import(\`\${folder}/index.ts\`);\nconst target = "../../gen/" + "index.ts";\nconst indirect = import((target as string)!);\nimport { initial as aliased } from "#oracle";\nconst outside = import("../../src/app.vibe");\nfunction unknown(folder: string) { return import(folder); }\nconst observe = () => start;\nconst named = { observe };\nvoid [named, advance, literal, interpolated, indirect, aliased, outside, unknown];\n`));
    const pkg = JSON.parse(read("package.json", oracleRoot));
    fs.writeFileSync(path.join(oracleRoot, "package.json"), JSON.stringify({ ...pkg, imports: { "#oracle": "./gen/index.ts" } }));
    const missing = copyOfProject();
    fs.rmSync(path.join(missing, "test/drivers/index.ts"));
    const [oracle, unchecked, scaffolded] = await Promise.all([
      // Values of the generated module, imported or re-exported, would compare the spec with itself; its types are the contract.
      run(oracleRoot),
      // A book that takes its input on trust: the probes send each kind of event malformed.
      run(copyOfProject("src/app.vibe", (s) => s.replace("const event = try decodeEvent(input)", "const event = input as Event"))),
      run(missing),
    ]);
    assert.deepEqual(oracle.failed, ["tests"], oracle.text);
    const forbidden: [number, string][] = [[5, "../../gen/index.ts"], [6, "../../gen/index.effect.vibe"], [8, "../../gen/index.ts"], [9, "../../gen/index.ts"], [10, "../../gen/index.ts"], [12, "../../gen/index.ts"], [13, "../../gen/index.ts"], [15, "../../gen/index.ts"], [16, "#oracle"]];
    assert.equal(oracle.said("tests", /^a driver imports gen\/ as types only/)?.detail, forbidden.map(([line, module]) => `      test/drivers/index.ts:${line}: ${module}`).join("\n"), oracle.text);
    assert.deepEqual(unchecked.failed, ["traces"], unchecked.text);
    assert.ok(unchecked.said("traces", /^test\/drivers\/index\.ts: the program departs from the spec\n +conformance to spec\/index\.md: probe \{"type":"\w+","\w+":(1\.5|9007199254740992)\}, after \d+ events of a journey: the application (?:"accepted" it, where the spec refuses it|failed: )/), unchecked.text);
    assert.ok(unchecked.said("traces", /probe/) && !/Saved as/.test(unchecked.text), "a probe is no trace to save");
    // src/ keeps the order's state with `apply`, so check writes the driver it lacks, which fails until it is filled in, and never again.
    assert.deepEqual(scaffolded.failed, ["traces"], scaffolded.text);
    assert.ok(scaffolded.said("traces", /^test\/drivers\/index\.ts: the run did not get as far as comparing\n +test\/drivers\/index\.ts: fill in reset, dispatch and observe$/), scaffolded.text);
    fs.appendFileSync(path.join(missing, "test/drivers/index.ts"), "// begun\n");
    const kept = await run(missing);
    assert.deepEqual(kept.failed, ["traces"], kept.text);
    assert.match(read("test/drivers/index.ts", missing), /^\/\/ The driver of spec\/index\.md[\s\S]*import type \{ Driver \} from "\.\.\/\.\.\/gen\/index\.conformance\.ts";[\s\S]*\/\/ begun\n$/);
  });

  test("nothing stale survives in gen/", async () => {
    const root = copyOfProject();
    fs.mkdirSync(path.join(root, "gen"), { recursive: true });
    for (const stale of ["renamed.ts", "renamed.effect.vibe", "index.effect.vibe.pure.d.ts"]) fs.writeFileSync(path.join(root, "gen", stale), "export const stale = true;\n");
    await check(root);
    // tsconfig.json keeps the compiler's declaration sidecars under .vibe/declarations/.
    assert.deepEqual(fs.readdirSync(path.join(root, "gen")).filter((f) => /\.(ts|vibe)$/.test(f)).sort(),
      ["_conformance.ts", "index.conformance.ts", "index.effect.vibe", "index.ts"]);
  });

  test("a truncated cache entry is recomputed and generated modules run in a CommonJS project", async () => {
    const root = fixtures(["door"], (f) => { f["package.json"] = '{"type":"commonjs"}'; });
    const before = await run(root);
    assert.deepEqual(before.failed, ["review"], before.text);
    const cache = path.join(root, ".spec-cache");
    const entries = fs.readdirSync(cache).filter((f) => f.endsWith(".json"));
    assert.ok(entries.length > 0);
    for (const entry of entries) fs.writeFileSync(path.join(cache, entry), "{");
    const after = await run(root);
    assert.deepEqual(after.failed, ["review"], after.text);
    for (const entry of fs.readdirSync(cache).filter((f) => f.endsWith(".json"))) assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(cache, entry), "utf8")));
  });

  test("changing an imported definition invalidates model and simulation results", async () => {
    const wrap = (quint: string) => ruleSpec(quint, "Price", "Library", "Values");
    const root = libAndUse(wrap("pure val price = 1"), wrap('import lib.* from "./lib"\npure def lawPrice(k: int): bool = price == 1'));
    const first = await run(root);
    assert.deepEqual(first.failed, ["review"], first.text);
    fs.writeFileSync(path.join(root, "spec/lib.md"), wrap("pure val price = 2"));
    const after = await run(root);
    assert.equal(after.said("always", /the law .* is false/)?.ok, false, after.text);
    // A renamed heading leaves the Quint as it was, and is still not served the remembered failure under its old name.
    fs.writeFileSync(path.join(root, "spec/use.md"), ruleSpec('import lib.* from "./lib"\npure def lawPrice(k: int): bool = price == 1', "The price is one", "Library", "Values"));
    const renamed = await run(root);
    assert.match(JSON.stringify(renamed.said("always", /the law .* is false/)), /The price is one/, renamed.text);
  });

  test("proof caching follows library changes and compiler failure waits for proof completion", async () => {
    const root = toolchain(fixtures(["highest"], (f) => { f["package.json"] = '{"type":"module"}'; }), "quint", "lsc");
    const script = path.join(root, "vibestack/spec.ts");
    const first = await runCli(script, root, "check", "--json");
    const checked = JSON.parse(first.stdout);
    assert.ok(checked.results.some((r: Result) => r.stage === "proof" && r.ok), first.stdout + first.stderr);
    const marker = "// A distinct proof-library version for this scratch project.";
    fs.appendFileSync(path.join(root, "vibestack/proof/lib.dfy"), `\n${marker}\n`);
    const second = await runCli(script, root, "check", "--json");
    const again = JSON.parse(second.stdout);
    assert.ok(again.results.some((r: Result) => r.stage === "proof" && r.ok), second.stdout + second.stderr);
    assert.ok(fs.readFileSync(path.join(root, "gen/proof/highest/highest.dfy"), "utf8").includes(marker));
    fs.writeFileSync(path.join(root, "tsconfig.json"), '{"compilerOptions":{"noEmit":true},"include":["gen/*.ts"]}');
    if (process.platform !== "win32") {
      const compiler = path.join(root, "node_modules/.bin/vibelang");
      fs.writeFileSync(compiler, "#!/bin/sh\nexit 1\n");
      fs.chmodSync(compiler, 0o644);
    }
    fs.appendFileSync(path.join(root, "spec/highest.proof.dfy"), "// Recheck the proof beside the failed compiler.\n");
    const failed = await runCli(script, root, "check", "--json");
    const result = JSON.parse(failed.stdout);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.ok(result.results.some((r: Result) => r.stage === "types" && !r.ok), failed.stdout);
    assert.ok(result.results.some((r: Result) => r.stage === "proof" && r.ok), failed.stdout);
    assert.ok(!fs.existsSync(path.join(root, ".spec-cache/lock")));
  });

  test("proof and task cache identity follows verifier and compiler bytes rather than installation directories", { skip: process.platform === "win32" }, async () => {
    const credentials = { apiUrl: "https://trusted-cache.example", writeToken: "test-only-publisher" };
    const trusted = { TURBO_API: credentials.apiUrl, TURBO_TOKEN: credentials.writeToken };
    const cases: [NodeJS.ProcessEnv, string[], string | undefined, NodeJS.ProcessEnv][] = [
      [{}, [], credentials.apiUrl, trusted],
      [{}, [], undefined, {}],
      [{}, [], "https://other-cache.example", {}],
      [{ TURBO_API: "https://other-cache.example" }, [], credentials.apiUrl, { TURBO_API: "https://other-cache.example" }],
      [{ TURBO_API: credentials.apiUrl }, [], "https://other-cache.example", trusted],
      [{ TURBO_TOKEN: "explicit" }, [], credentials.apiUrl, { TURBO_TOKEN: "explicit" }],
      [{ TURBO_TOKEN: "" }, [], credentials.apiUrl, { TURBO_TOKEN: "" }],
      [{}, ["--token", "explicit"], credentials.apiUrl, {}],
      [{}, ["--token=explicit"], credentials.apiUrl, {}],
      [{}, ["--api", "https://other-cache.example"], credentials.apiUrl, {}],
      [{}, ["--api=https://other-cache.example"], credentials.apiUrl, {}],
      [{ TURBO_API: "https://other-cache.example" }, ["--api", credentials.apiUrl], undefined, trusted],
      [{}, ["--api=https://other-cache.example", `--api=${credentials.apiUrl}`], undefined, trusted],
      [{}, [`--api=${credentials.apiUrl}`, "--api=https://other-cache.example"], undefined, {}],
      [{}, ["--", "--api=https://other-cache.example"], credentials.apiUrl, trusted],
    ];
    for (const [env, args, declared, expected] of cases) assert.deepEqual(cacheCredentials(env, args, declared, credentials), expected, JSON.stringify({ env, args, declared }));
    const root = scratch({});
    const names = ["first", "moved", "changed", "assemblies"];
    for (const name of names) {
      const directory = path.join(root, name);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "dafny"), "#!/bin/sh\nprintf '4.11.0\\n'\n", { mode: 0o755 });
      fs.writeFileSync(path.join(directory, "z3"), `#!/bin/sh\n${name === "changed" ? "# a different solver build\n" : ""}printf 'Z3 version 4.12.1\\n'\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(directory, "Dafny.dll"), name === "assemblies" ? "another verifier" : "the verifier");
      fs.writeFileSync(path.join(directory, "System.Private.CoreLib.dll"), "the self-contained runtime");
    }
    const script = `const { entry, toolchainFingerprint } = await import(${JSON.stringify(path.join(project, "vibestack/cache.ts"))}); console.log(JSON.stringify({ proof: (await entry(".", "prove", ["same obligation"])).name, task: await toolchainFingerprint() }));`;
    const keys = await Promise.all(names.map(async (name) => {
      const result = await exec(process.execPath, ["--input-type=module", "--eval", script], root,
        { ...process.env, PATH: `${path.join(root, name)}${path.delimiter}${process.env.PATH ?? ""}` });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    }));
    assert.deepEqual(keys[0], keys[1], "moving the same tools preserves proof and task results");
    for (const other of keys.slice(2)) {
      assert.notEqual(keys[0].proof, other.proof, "different verifier bytes invalidate a proof even at the same version");
      assert.notDeepEqual(keys[0].task, other.task, "different verifier bytes invalidate a task even at the same version");
    }
    assert.match(keys[0].task.node.digest, /^[a-f0-9]{64}$/);
    assert.match(keys[0].task.vibelang.digest, /^[a-f0-9]{64}$/);
  });

  test("the shared task cache restores artifacts and metadata and refuses unauthorized or oversized writes", async () => {
    const reader = "reader-".padEnd(48, "r"), writer = "writer-".padEnd(48, "w");
    const cache = new Miniflare({ telemetry: { enabled: false }, cf: false, enableDevRegistry: false, logRequests: false, workers: [{ config: {
      name: "cache", compatibilityDate: "2026-11-13",
      manifest: { mainModule: "cache.mjs", modules: { "cache.mjs": { type: "esm", contents: stripTypeScriptTypes(read("vibestack/remote-cache.ts")) } } },
      env: {
        CACHE_BUCKET: { type: "r2", name: "artifacts" },
        CACHE_READ_TOKEN: { type: "text", value: reader }, CACHE_WRITE_TOKEN: { type: "text", value: writer },
      },
    } }] });
    try {
      const hash = "0123456789abcdef", payload = "artifact bytes";
      const request = (method: string, target: string, token = reader, body?: string | Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) =>
        cache.dispatchFetch(`https://cache.test/v8/artifacts/${target}`, {
          method, headers: { Authorization: `Bearer ${token}`, ...headers }, ...(body === undefined ? {} : { body }),
        });
      for (const token of ["", "wrong-".padEnd(48, "x")]) assert.equal((await request("GET", "status", token)).status, 401);
      let response = await request("PUT", hash, writer, payload, { "Content-Length": String(payload.length), "x-artifact-duration": "42", "x-artifact-tag": "c2lnbmF0dXJl", "x-artifact-sha": "1".repeat(40) });
      assert.equal(response.status, 200, await response.text());
      response = await request("GET", hash);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), payload);
      assert.deepEqual(["x-artifact-duration", "x-artifact-tag", "x-artifact-sha"].map((header) => response.headers.get(header)), ["42", "c2lnbmF0dXJl", "1".repeat(40)]);
      response = await request("HEAD", hash);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "");
      assert.equal(response.headers.get("content-length"), String(payload.length));
      assert.equal((await request("GET", "f".repeat(16))).status, 404);
      assert.equal((await request("PUT", "e".repeat(16), reader, "x", { "Content-Length": "1" })).status, 403);
      assert.equal((await request("GET", "not-a-hash")).status, 400);
      const oversized = new URL(`/v8/artifacts/${"d".repeat(16)}`, await cache.ready);
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const failed = (error: Error) => { upload.destroy(); reject(error); };
        const upload = httpRequest(oversized, { method: "PUT", headers: {
          Authorization: `Bearer ${writer}`, "Content-Length": String(64 * 1024 * 1024 + 1), Expect: "100-continue",
        } }, (response) => {
          response.resume();
          response.on("error", failed);
          response.on("end", () => { resolve(response.statusCode); upload.destroy(); });
        });
        upload.on("error", failed);
        // The Worker rejects the declared length before the client sends the body.
        upload.flushHeaders();
      });
      assert.equal(status, 413);
      assert.equal((await request("POST", "events", reader, "private telemetry")).status, 200);
      response = await cache.dispatchFetch("https://cache.test/v8/artifacts", {
        method: "POST", headers: { Authorization: `Bearer ${reader}` }, body: JSON.stringify({ hashes: [hash, "f".repeat(16)] }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { [hash]: { size: payload.length, taskDurationMs: 42, tag: "c2lnbmF0dXJl" }, ["f".repeat(16)]: null });
      const { CACHE_BUCKET: bucket } = await cache.getBindings<{ CACHE_BUCKET: { list(): Promise<{ objects: { key: string }[] }> } }>();
      assert.deepEqual((await bucket.list()).objects.map((object) => object.key), [`lalalune/vibestack/${hash}`]);
    } finally {
      await cache.dispose();
    }
  });

  test("a story's text, a definition a rule relies on, here or in an imported spec, and a src contract are each reviewed", () => {
    const root = copyOfProject();
    const edit = (file: string, change: (s: string) => string) => fs.writeFileSync(path.join(root, file), change(fs.readFileSync(path.join(root, file), "utf8")));
    assert.deepEqual(pendingItems(root), []);
    const original = read("spec/index.md", EXAMPLE);
    edit("spec/index.md", (s) => s.replace("so that I can buy\n> several things in one go.", "so that I can buy\n> many things at once."));
    assert.deepEqual(pendingItems(root), ["Story: Fill a draft: story changed"]);
    edit("spec/index.md", () => original.replace("pure val unitPrice = 5", "pure val unitPrice = 7"));
    const moved = pendingItems(root);
    assert.ok(moved.includes("Domain / Unit price and order size: model changed"), moved.join("\n"));
    assert.ok(moved.includes("Story: Fill a draft / Items can only be added to a draft: model changed through maxUnits, unitPrice (Domain / Unit price and order size)"), moved.join("\n"));
    assert.ok(moved.includes("Story: Fill a draft / The amount due is always the price of the units: model changed through unitPrice (Domain / Unit price and order size)"), moved.join("\n"));
    assert.ok(!moved.some((m) => m.startsWith("Story: Check out / A payment never exceeds the balance")), "a rule that does not use the price is not flagged");

    // Across specs: a change to a library definition flags the rules that use it,
    // through a namespace beside a local namesake, and past a comment that hides a namesake.
    const libChanged = (root: string, lib: string) => {
      for (const spec of readSpecs(root)) acceptReviews(root, spec);
      fs.writeFileSync(path.join(root, "spec/lib.md"), lib);
      return pendingItems(root);
    };
    const flagged = libChanged(fixtures(["lib", "shop"]), read("vibestack/fixtures/lib.md").replace("acc + x)", "x + acc)"));
    assert.ok(flagged.includes("Story: Fill a cart / A cart holds lines: model changed through total (spec/lib.md: Sums / The total of a list)"), flagged.join("\n"));
    const names = (quint: string) => ruleSpec(quint, "Identity", "Names", "Rules");
    const namespaced = libChanged(libAndUse(names("pure def identity(n: int): int = n"), names('import lib as L from "./lib"\npure def identity(n: int): int = 0\npure def lawIdentity(n: int): bool = L::identity(n) == n')),
      names("pure def identity(n: int): int = n + 0"));
    assert.ok(namespaced.some((item) => item.includes("model changed through") && item.includes("identity")), namespaced.join("\n"));
    const lib = ruleSpec("pure def value(n: int): int = n + 1", "Imported", "Names", "Rules");
    const hidden = libChanged(libAndUse(lib, `# Use\n\n## Rules\n\n### Local\n\n${F}quint\nimport lib.* from "./lib"\n/*\npure def value(n: int): int = 0\n*/\npure def other(n: int): int = n\n${F}\n\n### Uses imported value\n\n${F}quint\npure def lawValue(n: int): bool = value(n) > n\n${F}\n`),
      lib.replace("n + 1", "n + 2"));
    assert.ok(hidden.some((item) => item.startsWith("Rules / Uses imported value: model changed through") && item.includes("value")), hidden.join("\n"));

    // The //@ lines of hand-written code: changed, new, and gone, whether the file loses them or is deleted.
    const contract = () => pendingContracts(root).map((p) => `${p.where}: ${p.status}`);
    assert.deepEqual(contract(), []);
    edit("src/ledger.ts", (s) => s.replace("  //@ ensures \\result >= 0\n", ""));
    fs.writeFileSync(path.join(root, "src/extra.ts"), ONE);
    assert.deepEqual(contract(), ["src/extra.ts: new contract", "src/ledger.ts: contract changed"]);
    acceptContracts(root);
    edit("src/ledger.ts", (s) => s.replace(/^.*\/\/@.*\n/gm, ""));
    fs.rmSync(path.join(root, "src/extra.ts"));
    assert.deepEqual(contract(), ["src/extra.ts: contract removed", "src/ledger.ts: contract removed"]);
  });

  test("source edited by a test cannot be accepted with a proof of its earlier contents", async () => {
    const changed = ONE.replace("return 1", "return 2");
    const root = fixtures(["door"], (f) => {
      f["src/count.ts"] = ONE;
      f["package.json"] = JSON.stringify({ scripts: { test: "node --test test/change.test.ts" } });
      f["test/change.test.ts"] = `${citing("spec/door.md", "Story: Use the door")}import fs from "node:fs";\nimport { test } from "node:test";\ntest("an editor changes source", () => fs.writeFileSync("src/count.ts", ${JSON.stringify(changed)}));\n`;
    });
    for (const spec of readSpecs(root)) acceptReviews(root, spec);
    acceptContracts(root);
    const ledger = fs.readFileSync(path.join(root, "spec/lock.json"), "utf8");
    const result = await run(root, "reviews");
    assert.equal(result.said("review", /^sources changed while the check ran; nothing was accepted/)?.ok, false, result.text);
    assert.equal(fs.readFileSync(path.join(root, "spec/lock.json"), "utf8"), ledger);
  });

  test("moving an unchanged contract to another function requires review", () => {
    const text = `${ONE}//@ pure\nexport function two(): number {\n  return 2;\n}\n`;
    const root = scratch({ "src/count.ts": text });
    fs.mkdirSync(path.join(root, "spec"));
    acceptContracts(root);
    fs.writeFileSync(path.join(root, "src/count.ts"), text.replace("  //@ ensures \\result === 1\n", "").replace("  return 2;", "  //@ ensures \\result === 1\n  return 2;"));
    assert.deepEqual(pendingContracts(root).map((p) => p.status), ["contract changed"]);
  });

  test("accept records a changed story and a changed contract, after which nothing is left to reconcile", async () => {
    const root = copyOfProject("src/ledger.ts", (s) => s.replace("  //@ ensures order.status === \"Paid\" ==> \\result === 0\n", ""));
    fs.writeFileSync(path.join(root, "spec/index.md"), read("spec/index.md", EXAMPLE).replace("> get my money back.", "> get all my money back."));
    const before = await run(root);
    assert.deepEqual(before.failed, ["review"], before.text);
    assert.ok(before.said("review", /story changed/) && before.said("review", /src\/ledger\.ts\n\s+contract changed/), before.text);
    assert.match(before.next, /pnpm accept/);
    await check(root, "reviews");
    const after = await run(root);
    assert.deepEqual(after.failed, [], after.text);
    assert.equal(after.next, "all green");
    // The total is the `ensures` of the generated Dafny: three remain after the paid-order clause is removed; loop invariants are not counted.
    assert.ok(after.said("proof", /^src-ledger\.ts: all 3 obligations proved/), after.text);
  });

  test("a second check is refused, stale locks are taken over, and cache retention preserves recent branches within its budget", async () => {
    const root = fixtures(["door"]);
    const lock = path.join(root, ".spec-cache/lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, `${process.pid}\n`);
    await assert.rejects(check(root), /another check or accept is running in this project \(process \d+\)/);
    fs.writeFileSync(lock, `${spawnSync(process.execPath, ["-e", ""]).pid}\n`);
    const unused = path.join(root, ".spec-cache/000000000000000000000000.json");
    fs.writeFileSync(unused, "{}");
    const recent = path.join(root, `.spec-cache/prove-${"1".repeat(24)}.json`);
    const expired = path.join(root, `.spec-cache/prove-${"2".repeat(24)}.json`);
    fs.writeFileSync(recent, "{}");
    fs.writeFileSync(expired, "{}");
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    fs.utimesSync(expired, old, old);
    const { failed, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
    assert.ok(!fs.existsSync(lock), "the lock is released");
    assert.ok(!fs.existsSync(unused), "an unrecognized cache entry is deleted");
    assert.ok(!fs.existsSync(expired), "an unused entry past retention is deleted");
    assert.ok(fs.existsSync(recent), "a recent entry from another branch remains reusable");
    assert.ok(fs.readdirSync(path.dirname(lock)).length > 0, "the entries it used are kept");
    const newer = path.join(root, `.spec-cache/prove-${"3".repeat(24)}.json`);
    fs.writeFileSync(newer, "{}");
    const file = fs.openSync(recent, "r+");
    fs.ftruncateSync(file, 256 * 2 ** 20);
    fs.closeSync(file);
    const earlier = new Date(Date.now() - 60_000);
    fs.utimesSync(recent, earlier, earlier);
    const current = new Set(fs.readdirSync(path.dirname(lock)).filter((name) => name !== path.basename(recent) && name !== path.basename(newer)));
    collectGarbage({ root, fresh: false, used: current });
    assert.ok(!fs.existsSync(recent), "the oldest unused entry is evicted to fit the byte budget");
    assert.ok(fs.existsSync(newer), "a newer alternative remains after the budget is satisfied");
    for (const name of current) assert.ok(fs.existsSync(path.join(path.dirname(lock), name)), "this check's entries are never evicted");
  });

  test("a rebuilt packaged command can generate a project from the repository root", async () => {
    const root = oneRule("packaged", "A packaged value", "pure val answer = 42");
    const inputs = ["package.json", "tsconfig.json", "tsconfig.build.json", "tsconfig.base.json", "turbo.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", ".nvmrc"];
    const staging = scratch(Object.fromEntries(inputs.map((file) => [file, read(file)])));
    // Studio's page is built from the workspace packages it shares with every interface.
    for (const directory of ["vibestack", "packages", "apps", "spec"])
      copySources(path.join(project, directory), path.join(staging, directory));
    const lock = path.join(staging, "vibestack/studio/.spec-cache/lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, `${process.pid}\n`);
    fs.mkdirSync(path.join(staging, "node_modules"));
    fs.writeFileSync(path.join(staging, "node_modules/should-not-copy"), "dependencies belong to the scratch install\n");
    const copy = scratch({});
    copySources(staging, copy);
    const fixture = "vibestack/stories/test/fixtures/gen/index.ts";
    assert.deepEqual(fs.readFileSync(path.join(copy, fixture)), fs.readFileSync(path.join(project, fixture)));
    assert.ok(!fs.existsSync(path.join(copy, "vibestack/studio/.spec-cache/lock")));
    assert.ok(!fs.existsSync(path.join(copy, "node_modules")));
    assert.equal(read("vibestack/gen/typescript.ts", copy), read("vibestack/gen/typescript.ts"));
    for (const directory of ["vibestack/studio", ...fs.readdirSync(path.join(copy, "packages")).map((name) => `packages/${name}`)])
      for (const output of ["gen", "dist", "generated", "node_modules", ".spec-cache", ".cache", ".vibe", ".turbo", "storybook-static"])
        assert.ok(!fs.existsSync(path.join(copy, directory, output)), `${directory}/${output} is produced by the scratch build`);
    const dependencies = await exec(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"], copy);
    assert.equal(dependencies.status, 0, dependencies.stdout + dependencies.stderr);
    const built = await exec(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["run", "build"], copy, { ...process.env, TURBO_CACHE: "local:rw" });
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const script = path.join(copy, "dist/spec.js");
    fs.chmodSync(script, 0o755);
    const generated = await exec(process.platform === "win32" ? process.execPath : script,
      [...(process.platform === "win32" ? [script] : []), "gen", root], copy);
    assert.equal(generated.status, 0, generated.stdout + generated.stderr);
    assert.equal((await import(path.join(root, "gen/packaged.ts"))).answer, 42);

    // pnpm exposes transitive executables as regular shims while keeping their package beside the tool's dependency.
    const consumer = oneRule("arithmetic", "A value equals itself", "pure def lawIdentity(n: int): bool = n == n");
    const installed = path.join(consumer, "node_modules/vibestack");
    fs.mkdirSync(path.join(installed, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(installed, "package.json"), '{"type":"module"}');
    fs.cpSync(path.join(copy, "dist"), path.join(installed, "dist"), { recursive: true });
    for (const entry of fs.readdirSync(nodeModules).filter((name) => name !== ".bin"))
      fs.symlinkSync(path.join(nodeModules, entry), path.join(installed, "node_modules", entry), fs.statSync(path.join(nodeModules, entry)).isDirectory() ? "dir" : "file");
    const binaries = path.join(consumer, "node_modules/.bin");
    fs.mkdirSync(binaries, { recursive: true });
    fs.symlinkSync(path.join(nodeModules, ".pnpm"), path.join(consumer, "node_modules/.pnpm"), "dir");
    for (const dependency of ["@informalsystems", "typescript"])
      fs.symlinkSync(path.join(nodeModules, dependency), path.join(consumer, "node_modules", dependency), "dir");
    const quint = process.platform === "win32" ? "quint.cmd" : "quint";
    fs.symlinkSync(path.join(nodeModules, ".bin", quint), path.join(binaries, quint), "file");
    const lsc = path.join(nodeModules, "lemmascript/tools/dist/lsc.js");
    const shim = path.join(binaries, process.platform === "win32" ? "lsc.cmd" : "lsc");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    fs.writeFileSync(shim, process.platform === "win32" ? `@"${process.execPath}" "${lsc}" %*\r\n` : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(lsc)} "$@"\n`);
    fs.chmodSync(shim, 0o755);
    assert.ok(!fs.existsSync(path.join(consumer, "node_modules/lemmascript")));
    const checked = await runCli(path.join(installed, "dist/spec.js"), consumer, "check", "--json");
    const proof = JSON.parse(checked.stdout).results.find((result: Result) => result.stage === "proof");
    assert.ok(proof?.ok, checked.stdout + checked.stderr);
    assert.match(proof.summary, /all 1 obligations proved/);
  });

  test("the command line checks, generates and watches a project directory from its parent", async () => {
    const script = path.join(project, "vibestack/spec.ts");
    const cli = (root: string, ...args: string[]) => runCli(script, root, ...args);
    const oldNode = await exec(process.execPath, ["--import", "data:text/javascript,Object.defineProperty(process.versions,'node',{value:'24.15.0'})", script, "gen"], scratch({}));
    assert.equal(oldNode.status, 1, oldNode.stdout + oldNode.stderr);
    assert.match(oldNode.stderr, /spec needs Node 26 or later/);
    const parent = scratch({});
    const root = path.join(parent, "a project");
    fs.mkdirSync(root);
    const blank = scratch({ "spec/index.md": "" });
    assert.equal((await cli(blank, "new")).status, 0);
    assert.match(fs.readFileSync(path.join(blank, "spec/index.md"), "utf8"), /## Story:/);
    assert.equal((await cli(blank, "new")).status, 1);
    assert.equal((await cli(blank, "new", "area/child")).status, 0);
    assert.ok(fs.existsSync(path.join(blank, "spec/area/child/index.md")));
    assert.equal((await cli(blank, "new", "../escape")).status, 1);
    fs.writeFileSync(path.join(blank, "spec/conflict.md"), "");
    assert.equal((await cli(blank, "new", "conflict")).status, 1);
    assert.equal(fs.existsSync(path.join(blank, "spec/conflict")), false);
    assert.equal((await cli(root, "new", "Tally")).status, 1);
    const namedSrc = scratch({});
    assert.equal((await cli(namedSrc, "new", "src")).status, 0);
    assert.ok(fs.existsSync(path.join(namedSrc, "spec/src/index.md")), "the unified ledger leaves src available as a spec name");
    assert.equal((await cli(root, "new", "tally")).status, 0);
    assert.match((await cli(root, "new", "tally")).stderr, /spec\/tally\/index\.md already exists/);
    const missing = await cli(root, "accept", "unprovd");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /not an existing project directory/);
    assert.equal((await cli(root, "accept", "--unprovd")).status, 2);
    assert.equal((await cli(root, "check", "--everything")).status, 2);
    // The starter spec passes every stage but review, and proves without a proof file.
    const checked = JSON.parse((await cli(parent, "check", "a project", "--json")).stdout);
    assert.deepEqual([...new Set(checked.results.filter((r: Result) => !r.ok).map((r: Result) => r.stage))], ["review"], JSON.stringify(checked, null, 2));
    for (const stage of ["model", "always", "sometimes", "replay", "proof"]) assert.ok(checked.results.some((r: Result) => r.stage === stage && r.ok), stage);
    assert.match(checked.next, /pnpm accept/);
    assert.ok(fs.existsSync(path.join(root, "gen/tally.ts")));
    assert.ok(!fs.existsSync(path.join(parent, "gen")));
    const accepted = await cli(parent, "accept", root);
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    assert.ok(fs.existsSync(path.join(root, "spec/lock.json")));
    assert.ok(!fs.existsSync(path.join(parent, "spec")));
    assert.equal((await cli(parent, "migrate", root)).status, 0);
    assert.equal((await cli(parent, "gen", root)).status, 0);
    fs.renameSync(path.join(root, "spec/tally"), path.join(root, "spec/counter"));
    assert.equal((await cli(parent, "gen", root)).status, 0);
    assert.ok(fs.existsSync(path.join(root, "gen/counter.ts")));
    assert.ok(!fs.readdirSync(path.join(root, "gen")).some((file) => file.startsWith("tally.")));
    fs.renameSync(path.join(root, "spec/counter"), path.join(root, "spec/tally"));
    const lock = path.join(root, ".spec-cache/lock");
    fs.writeFileSync(lock, `${process.pid}\n`);
    const blocked = await cli(parent, "gen", root);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /another check or accept is running/);
    fs.rmSync(lock);
    fs.appendFileSync(path.join(root, "spec/tally/index.md"), `\n### Broken\n\n${F}quint\npure def\n${F}\n`);
    const lenient = await cli(parent, "gen", "--if-valid", root);
    assert.equal(lenient.status, 0, lenient.stderr);
    assert.match(lenient.stdout, /^note: gen\/ was not generated/);
    assert.equal((await cli(parent, "gen", root)).status, 1);
    assert.equal((await cli(root, "gen")).status, 1);
    for (const target of ["missing", path.join(root, "spec/tally/index.md")]) {
      const invalid = await cli(parent, "check", target);
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /not an existing project directory/);
    }
    assert.equal((await cli(parent, "check", root, parent)).status, 2);

    const watchedRoot = path.join(parent, "watched project");
    fs.mkdirSync(watchedRoot);
    assert.equal((await cli(parent, "init", watchedRoot)).status, 0);
    const watcher = spawn(process.execPath, [script, "watch", watchedRoot], { cwd: parent, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    watcher.stdout.on("data", (chunk) => { output += chunk; });
    watcher.stderr.on("data", (chunk) => { output += chunk; });
    const waitFor = (ready: () => boolean) => until(() => { assert.equal(watcher.exitCode, null, output); return ready(); }, () => output);
    try {
      await waitFor(() => output.includes("watching spec/"));
      fs.writeFileSync(path.join(watchedRoot, "spec/index.md"), ruleSpec("pure val watchedValue = 1", "Value", "Watched"));
      const generated = path.join(watchedRoot, "gen/index.ts");
      await waitFor(() => fs.existsSync(generated) && fs.readFileSync(generated, "utf8").includes("export const watchedValue"));
      await waitFor(() => (output.match(/watching spec\//g)?.length ?? 0) >= 2);
      assert.equal((await import(generated)).watchedValue, 1);
      assert.ok(!fs.existsSync(path.join(parent, "gen")));
      const runs = output.match(/watching spec\//g)?.length ?? 0;
      fs.mkdirSync(path.join(watchedRoot, "spec/app"));
      fs.writeFileSync(path.join(watchedRoot, "spec/app/index.md"), "");
      await waitFor(() => (output.match(/watching spec\//g)?.length ?? 0) > runs);
      fs.mkdirSync(path.join(watchedRoot, "apps/app"), { recursive: true });
      fs.writeFileSync(path.join(watchedRoot, "apps/app/package.json"), '{"name":"watched-app","type":"module"}');
      await waitFor(() => output.includes("apps/app: skipped: there is no tsconfig.json"));
      output = "";
      fs.writeFileSync(path.join(watchedRoot, "apps/app/tsconfig.json"), '{"compilerOptions":{"unknownOption":true}}');
      await waitFor(() => output.includes("apps/app: application does not fit the generated contract"));
      assert.match(output, /Unknown compiler option 'unknownOption'/);
    } finally {
      if (watcher.exitCode === null && watcher.signalCode === null) {
        const closed = new Promise((resolve) => watcher.once("close", resolve));
        watcher.kill("SIGTERM");
        await closed;
      }
    }
  });

  test("a fence of any length or kind holds prose, and closes only with its own kind and length", () => {
    const four = "`".repeat(4);
    const root = scratch({ "spec/f.md": `# F\n\n## Story\n\n### Real\n\n${F}quint\npure val a = 1\n${F}\n\n${four}markdown\n### Not a rule\n${F}quint\npure val b = 2\n${F}\n${four}\n\n~~~\n### Nor this\n${F}\n~~~\n\n### Also real\n\n${F}quint\npure val c = 3\n${F}\n` });
    const spec = parseSpec(root, "spec/f.md");
    assert.deepEqual(spec.rules.map((r) => r.key), ["Story / Real", "Story / Also real"]);
    assert.deepEqual(spec.rules.flatMap((r) => r.defs), ["a", "c"]);
    assert.match(spec.rules[0].prose, /### Not a rule[\s\S]*### Nor this/);
  });
  // Each of these is a way a false obligation could be reported as proved.
  const bumpHeader = "lemma bump_ensures(c: C, k: int)\n  ensures (inv(c) ==> canBump(c, k) ==> alwaysNonNegative(bump(c, k)))\n  ensures (inv(c) ==> canBump(c, k) ==> alwaysBumpsNonNegative(bump(c, k)))\n{\n";
  const magic = (proof?: string) => fixtures(["magic"], (f) => { if (proof !== undefined) f["spec/magic.proof.dfy"] = proof; });

  test("a proof file reaches the standard library only by the names the generated code uses, and the tools' library only by its own", () => {
    const lib = fs.readFileSync(LIB_FILE, "utf8");
    const gen = "function f(xs: seq<int>): bool\n{\n  Std.Collections.Seq.All(xs, (x: int) => x > 0)\n}\n\nlemma f_ensures(xs: seq<int>)\n  ensures (f(xs) == true)\n{\n}\n";
    const header = "lemma f_ensures(xs: seq<int>)\n  ensures (f(xs) == true)\n{\n";
    const spliced = (body: string) => splice(gen, { proof: { file: "p.dfy", text: `${header}${body}\n}\n` }, axioms: [], lib }).dfy;
    // Std.Ordinal.TimesIncreasingOnLeft is a false {:axiom}; dafny audit reports it only against the library's own file.
    assert.throws(() => spliced("  Std.Ordinal.TimesIncreasingOnLeft(0, 0, 0);"), /p\.dfy:4: `Std\.Ordinal\.TimesIncreasingOnLeft` is not allowed[^\n]*\(Std\.Collections\.Seq\.All\)/);
    assert.throws(() => spliced("  ProofLib.Seq.LemmaFlattenConcat<int>([], []);"), /`ProofLib\.Seq\.LemmaFlattenConcat` is not a lemma or function of vibestack\/proof\/lib\.dfy/);
    assert.throws(() => spliced("  assert (xs).Std.Ordinal == 0;"), /`Std` may only begin a name/);
    assert.ok(spliced("  assert Std.Collections.Seq.All(xs, (x: int) => x > 0) == f(xs);\n  ProofLib.FilterNil((x: int) => true, []);").includes("ProofLib.FilterNil"));
  });

  test("a failure is charged to the definition it is in, by where the tools put each line, not by reading the text back", () => {
    const { dfy, regions } = splice(GENERATED_F, { proof: { file: "p.dfy", text: "lemma\nLiar()\n  ensures false\n{\n}\nlemma f_ensures(x: int)\n  ensures (f(x) >= x)\n{\n  Liar();\n}\n" }, axioms: [] });
    const lines = dfy.split("\n");
    const liar = lines.indexOf("Liar()");
    assert.deepEqual(regions[liar], { def: "Liar", generated: false });
    assert.equal(regions[lines.indexOf("  Liar();")].def, "f_ensures");
    const out = (summary: string, ...messages: string[]) => `${messages.join("\n")}\n\nDafny program verifier finished with ${summary}\n`;
    const failure = `t.dfy(${liar + 4},0): Error: a postcondition could not be proved on this return path\nt.dfy(${liar + 2},10): Related location: this is the postcondition that could not be proved`;
    assert.match([...readVerdict(out("3 verified, 1 error", failure), dfy, "t.dfy", regions).errors].join("\n"), /^Liar \(t\.dfy:\d+\) does not verify: false; a lemma that is not generated must prove$/);
    const runtime = splice(GENERATED_F, { axioms: [] }, "t.dfy", new Set(["f_ensures"]));
    const at = runtime.dfy.split("\n").findIndex((line) => line.includes("ensures (f(x)")) + 1;
    const rejected = readVerdict(out("1 verified, 1 error", `t.dfy(${at + 1},0): Error: a postcondition could not be proved on this return path`, `t.dfy(${at},0): Related location: this is the postcondition that could not be proved`), runtime.dfy, "t.dfy", runtime.regions);
    assert.equal(rejected.unproved.size, 0);
    assert.match([...rejected.errors].join("\n"), /one of LemmaScript's own helpers/);
  });

  test("a sibling postcondition cannot pass when its generated definition cannot be copied", () => {
    const dfy = "lemma f_ensures(n: int)\n  ensures n > 0\n  ensures n < 0\n{ }\n";
    const region = { def: "f_ensures", generated: true };
    const others = (ensures: number[]) => ensures.filter((l) => l !== 2).map((l) => [l]);
    const result = isolatedCopies({ dfy, regions: dfy.split("\n").map(() => region) }, new Map([["f_ensures", others]]));
    assert.equal(result.copies.length, 0);
    assert.deepEqual([...result.closed.keys()], ["f: n < 0"]);
    const unknown = isolatedCopies({ dfy, regions: [] }, new Map([["missing", others]]));
    assert.match(unknown.errors.join("\n"), /cannot locate the generated definition/);
    // A copy keeps only the postconditions picked, and each of its lines names the line it copies.
    const shaped = dfy.replace("{ }", "{\n}");
    const copied = isolatedCopies({ dfy: shaped, regions: shaped.split("\n").map(() => region) }, new Map([["f_ensures", others]]));
    assert.deepEqual(copied.copies.map(({ lines, origin }) => ({ lines, origin })), [{ lines: ["lemma isolated0_f_ensures(n: int)", "  ensures n < 0", "{", "}"], origin: [1, 3, 4, 5] }]);
  });

  test("a generated runtime helper does not inflate the unit's obligation count", async () => {
    const { said, text, failed } = await run(oneRule("division", "Divide", "pure def lawHalves(n: int): bool = n / 2 == n / 2"));
    assert.deepEqual(failed, ["review"], text);
    assert.ok(said("proof", /^division\.ts: all 1 obligations proved/), text);
  });

  test("only Dafny's own messages are read: from the start of a line, from the error's block and definition, and as many as it counted", () => {
    const gen = "lemma a_ensures(x: int)\n  ensures P(x)\n  ensures Q(x)\n{\n}\n\nlemma b_ensures(x: int)\n  ensures R(x)\n{\n}\n";
    const { dfy, regions } = splice(gen, { axioms: [] });
    const verdict = (...messages: string[]) => readVerdict(`${messages.join("\n")}\n`, dfy, "t.dfy", regions);
    const error = "t.dfy(4,0): Error: a postcondition could not be proved on this return path";
    const related = (line: number) => `t.dfy(${line},2): Related location: this is the postcondition that could not be proved`;
    const summary = (n: number) => `\nDafny program verifier finished with 2 verified, ${n} error${n === 1 ? "" : "s"}`;
    // A message in the text of a line (as an echoed source line would carry it) is not a message.
    const echoed = verdict(error, related(3), `  | //x/t.dfy(8,2): Related location: this is the postcondition that could not be proved`, summary(1));
    assert.deepEqual([...echoed.unproved.keys()], ["a: Q(x)"]);
    assert.deepEqual([...echoed.errors], []);
    // A postcondition of another definition does not answer for this one.
    const elsewhere = verdict(error, related(8), summary(1));
    assert.deepEqual([...elsewhere.unproved.keys()], []);
    assert.match([...elsewhere.errors].join("\n"), /a_ensures: a postcondition could not be proved on this return path, and Dafny named no postcondition of it/);
    // One that comes after another message is not part of the error's block.
    const later = verdict(error, "t.dfy(9,0): Warning: something", related(3), summary(1));
    assert.deepEqual([...later.unproved.keys()], []);
    // Fewer failures read than Dafny counted is an error, never a smaller list.
    assert.match([...verdict(error, related(3), summary(2)).errors].join("\n"), /Dafny reported 2 failures, but 1 were read from its output/);
  });

  test("a proof file can neither use the standard library's axioms, nor charge a helper's failure to an obligation, nor spoof Dafny's messages", async () => {
    const [std, liar, spoof] = await Promise.all([
      run(magic(`${bumpHeader}  Std.Ordinal.TimesIncreasingOnLeft(0, 0, 0);\n}\n`)),
      run(magic(`lemma\nLiar()\n  ensures false\n{\n}\n\n${bumpHeader}  Liar();\n}\n`)),
      // A message inside a source comment must not name mark's obligation in place of bump's.
      run(magic(`${bumpHeader}  return; //magic.dfy(39,40): Related location: this is the postcondition that could not be proved\n}\n`)),
    ]);
    assert.equal(std.said("proof", /^magic\.ts: Dafny could not check it[\s\S]*spec\/magic\.proof\.dfy:5: `Std\.Ordinal\.TimesIncreasingOnLeft` is not allowed/)?.ok, false, std.text);
    assert.equal(liar.said("proof", /^magic\.ts: Dafny could not check it[\s\S]*Liar \(magic\.dfy:\d+\) does not verify/)?.ok, false, liar.text);
    const spoofed = spoof.said("proof", /^magic\.ts: 3 of 6 obligations not proved/);
    assert.equal(spoofed?.ok, false, spoof.text);
    assert.match(spoofed!.detail, /bump: \(inv\(c\) ==> canBump\(c, k\) ==> alwaysNonNegative\(bump\(c, k\)\)\)/);
  });

  test("an obligation whose proof calls a lemma that is not proved is not proved either, the tools' own step body included", async () => {
    const markProof = "lemma mark_ensures(c: C, k: int)\n  ensures (inv(c) ==> canMark(c, k) ==> alwaysNonNegative(mark(c, k)))\n  ensures (inv(c) ==> canMark(c, k) ==> alwaysBumpsNonNegative(mark(c, k)))\n{\n  bump_ensures(C(0, 0), 777777);\n  assert false;\n}\n";
    const [bare, borrowed] = await Promise.all([run(magic()), run(magic(markProof))]);
    const plain = bare.said("proof", /^magic\.ts: 3 of 6 obligations not proved/);
    assert.equal(plain?.ok, false, bare.text);
    assert.match(plain!.detail, /step: inv\(step\(current, event\)\)   \[rests on bump: /);
    const resting = borrowed.said("proof", /^magic\.ts: 4 of 6 obligations not proved/);
    assert.equal(resting?.ok, false, borrowed.text);
    assert.match(resting!.detail, /mark: \(inv\(c\) ==> canMark\(c, k\) ==> alwaysNonNegative\(mark\(c, k\)\)\)   \[rests on bump: /);
  });

  test("a law is offered to an importer only if it is proved without resting on one that is not", async () => {
    const counter = read("vibestack/fixtures/magic.md").replace("type C = {", 'import forbidden.* from "./forbidden"\ntype C = {').replace(/### Mark by[\s\S]*?(?=### The count is never)/, "").replace(/### The count of bumps[\s\S]*?(?=### Bumped)/, "");
    const { said, text } = await run(fixtures(["forbidden"], (f) => Object.assign(f, {
      "spec/magic.md": counter,
      "spec/forbidden.proof.dfy": "lemma lawNotSecond_ensures(n: int)\n  ensures (lawNotSecond(n) == true)\n{\n  lawNotFirst_ensures(987654321);\n}\n",
      "spec/magic.proof.dfy": "lemma bump_ensures(c: C, k: int)\n  ensures (inv(c) ==> canBump(c, k) ==> alwaysNonNegative(bump(c, k)))\n{\n  forbidden_lawNotSecond_ensures(123456789);\n}\n",
    })));
    const lib = said("proof", /^forbidden\.ts: 2 of 2 obligations not proved/);
    assert.equal(lib?.ok, false, text);
    assert.match(lib!.detail, /lawNotSecond: \(lawNotSecond\(n\) == true\)   \[rests on lawNotFirst: /);
    assert.equal(said("proof", /^magic\.ts: Dafny could not check it[\s\S]*unresolved identifier: forbidden_lawNotSecond_ensures/)?.ok, false, text);
  });

  test("verified code is refused where the proof and Node would read it differently", () => {
    const refused: [string, string, RegExp][] = [
      ["the name of Dafny's standard library", "export const Std = 1;", /`Std` names a Dafny library/],
      ["a renamed import", 'import { sometimesFour as alwaysNotNegative, type C } from "../gen/counter.ts";', /may not rename what it imports/],
      ["a default import", 'import counter from "../gen/counter.ts";', /not a default or namespace import/],
      ["a namespace import", 'import * as counter from "../gen/counter.ts";', /not a default or namespace import/],
      ["an export list", "function double(x: number): number {\n  return x * 2;\n}\nexport { double as half };", /may hold only imports, functions with a body/],
      ["a re-export", 'export * from "../gen/counter.ts";', /may hold only imports, functions with a body/],
      ["a default export", "export default function f(): number {\n  return 1;\n}", /`default` is not allowed/],
      ["an export assignment", "const f = 1;\nexport = f;", /may hold only imports, functions with a body/],
      ["a statement at the top level", "Math.max = (a: number, b: number) => -1000;", /may hold only imports, functions with a body/],
      ["a declaration without a body", "declare function f(x: number): number;", /`declare` is not allowed/],
      ["an overload without a body", "export function f(x: number): number;\nexport function f(x: number): number {\n  return x;\n}", /may hold only imports, functions with a body/],
      ["a let", "let x = 1;", /may hold only imports, functions with a body/],
      ["an annotation in a block comment", "export function twice(x: number): number {\n  //@ ensures \\result >= x\n  /*\n  //@ ensures \\result === 3 * x\n  */\n  return x + x;\n}", /:5: `\/\/@` here is not in a `\/\/` comment/],
      ["an annotation in a doc comment", "/** //@ ensures \\result === 3 */\nexport function three(): number {\n  return 3;\n}", /:2: `\/\/@` here is not in a `\/\/` comment/],
      ["an annotation in a string", 'export const note = "//@ ensures false";', /`\/\/@` here is not in a `\/\/` comment/],
      ["an annotation in a template", "export const note = `${1} //@ ensures false`;", /`\/\/@` here is not in a `\/\/` comment/],
      ["a NUL character", "export const x = 1; // \0", /NUL characters are not allowed/],
      ["a carriage return in a comment", "export const x = 1; // \r hidden", /line break/],
      ["a Unicode line break in a comment", "export const x = 1; // \u2028 hidden", /line break/],
    ];
    for (const [what, code, message] of refused) assert.throws(() => checkVerifiedSource("src/x.ts", `//@ backend dafny\n${code}\n`), message, what);
    checkVerifiedSource("src/ledger.ts", read("src/ledger.ts", EXAMPLE));
    checkVerifiedSource("src/fields.ts", "//@ backend dafny\nexport interface Box { Std: number; ProofLib: number }\n//@ pure\nexport function value(box: Box): number { return box.Std + box.ProofLib; }\n");
    checkVerifiedSource("src/x.ts", '//@ backend dafny\n// What the //@ lines promise.\nimport { type C, inv } from "../gen/c.ts";\nexport type D = C;\nexport interface E { c: C }\nconst limit = 3;\n//@ pure\nexport function f(c: C): boolean {\n  //@ ensures \\result === inv(c)\n  return inv(c) && limit > 0 || inv(c);\n}\n');
    checkVerifiedSource("src/x.ts", "//@ backend dafny\nexport function f(x: number): number { //@ requires x > 0\n  let i = 0; //@ type nat\n  return x + i;\n}\n");
  });

  test("verified code that renames an import or re-exports, or annotations in a file that is not .ts, a VibeLang one included, fail the proof", async () => {
    const renamed = copyOfProject("src/guard.ts", () => '//@ backend dafny\nimport { canSubmit as canCancel, type Order } from "../gen/index.ts";\n//@ pure\nexport function cancellable(o: Order): boolean {\n  //@ ensures \\result === (o.status === "Pending")\n  return canCancel(o);\n}\n');
    const module = copyOfProject("src/dec.mts", () => "//@ backend dafny\nexport function dec(x: number): number {\n  //@ ensures \\result > x\n  return x - 1;\n}\n");
    const reexport = copyOfProject("src/ledger.ts", (s) => s + '\nexport * from "./app.vibe";\n');
    const vibe = copyOfProject("src/dec.vibe", () => "//@ backend dafny\nexport const dec = 1\n");
    const [r, m, x, v] = await Promise.all([run(renamed), run(module), run(reexport), run(vibe)]);
    assert.equal(r.said("proof", /src\/guard\.ts:2: `canSubmit as canCancel`: verified code may not rename what it imports/)?.ok, false, r.text);
    assert.equal(m.said("proof", /src\/dec\.mts: `\/\/@` appears in it, but only \.ts files under src\/ are proved/)?.ok, false, m.text);
    assert.equal(v.said("proof", /src\/dec\.vibe: `\/\/@` appears in it, but only \.ts files under src\/ are proved/)?.ok, false, v.text);
    assert.equal(x.said("proof", /src\/ledger\.ts.*may hold only imports, functions with a body/)?.ok, false, x.text);
  });

  test("hand-written code is not simulated, so none of its obligations can be accepted as simulated only", async () => {
    const root = fixtures(["door"], (f) => { f["src/inc.ts"] = "//@ backend dafny\n//@ pure\nexport function inc(x: number): number {\n  //@ ensures \\result === x\n  return x + 1;\n}\n"; });
    const { said, text } = await run(root, "unproved");
    const inc = said("proof", /^src-inc\.ts: 1 of 1 obligations not proved/);
    assert.equal(inc?.ok, false, text);
    assert.match(inc!.summary, /Hand-written code is not simulated, so they must be proved/);
    assert.doesNotMatch(inc!.summary, /accept -- unproved/);
    const ledger = path.join(root, "spec/lock.json");
    assert.ok(!fs.existsSync(ledger) || !fs.readFileSync(ledger, "utf8").includes("src-inc.ts"), text);
  });
});
