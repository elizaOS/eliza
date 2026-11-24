// Does each check catch the kind of mistake it exists for? Every case builds a
// scratch project, from the order example (vibestack/examples/order) or from the
// small specs in vibestack/fixtures/, breaks one thing, and asserts which stage of `check` fails.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { request as httpRequest } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, stripVTControlCharacters } from "node:util";
import { gzipSync, zstdDecompressSync } from "node:zlib";
import { Miniflare } from "miniflare";
import { violated } from "./action.ts";
import { cacheCredentials, collectGarbage, isActionEntry, withFormalCache, type installedProgram as lookupTool } from "./cache.ts";
import { LIB_FILE, isolatedCopies, parseProofFile, readVerdict, splice } from "./prove.ts";
import { heading } from "./parse.ts";
import { precomputeSimulations, prepareSimulationReceipts } from "./formal.ts";
import { exec, run as tool, toolCpuSeconds } from "./run.ts";
import { pendingSpecs, showPending, writeLedger } from "./review.ts";
import { filesUnder, packageScripts, testInputs, testReceipt, writeWhole } from "./util.ts";
import { profile } from "./testing/profile.ts";
import { installChromium } from "./chromium.ts";
import { hostedCachedFixture, isolatedInstalls } from "./selftests/install.ts";
import { PACKED, toolShards } from "./selftests/tools.ts";
import { bigNumberInteger } from "./gen/types.ts";
import { canonical, check as conformanceCheck, ConformanceError, departure, replay as replayTrace } from "./conformance.ts";
import { BUILTINS, LIST_HELPERS, OPERATORS } from "./gen/print.ts";
import { mirrorGen } from "./units.ts";
import { conformance as checkTraces, conformanceFound } from "./conform.ts";
import { explore, explored, pageInputs } from "./explore.ts";
import { harnessFiles, search, simulate, simulation } from "./simulate.ts";
import { acceptContracts, acceptReviews, NODE, check, checkVerifiedSource, danglingCitations, expandListHelpers, generated, init, parseSpec, pending, pendingContracts, readSpecs, replay, show, typecheckAll, type Result, type Spec } from "./pipeline.ts";

const project = path.join(import.meta.dirname, "..");
isolatedInstalls();
const harnessSkillPaths = [".claude/skills", ".codex/skills", ".cursor/skills", ".droid/skills", ".factory/skills", ".gemini/skills", ".grok/skills", ".grokbot/skills", ".muse/skills", ".t3/skills"];
const scaffoldedIgnores = ["gen/", ".spec-cache/", ".studio/", "dist/", ".vibe/", ".cache/", ".turbo/", "test/__traces__/", "/.claude/", "/CLAUDE.md", ...harnessSkillPaths.filter((alias) => !alias.startsWith(".claude/")).map((alias) => `/${alias}`)];
const EXAMPLES = "vibestack/examples";
const EXAMPLE = path.join(project, EXAMPLES, "order");
const read = (file: string, from = project): string => fs.readFileSync(path.join(from, file), "utf8");
const F = "`".repeat(3);
/** What makes the order example a VibeLang package: its manifest, and what its compiler and test runner read. */
const PACKAGE = Object.fromEntries(["package.json", "tsconfig.json", "vitest.config.ts"].map((f) => [f, read(f, EXAMPLE)]));
const roots: string[] = [];
const nodeModules = (function find(dir: string): string {
  const here = path.join(dir, "node_modules");
  return fs.existsSync(here) ? here : dir === path.dirname(dir) ? assert.fail("no node_modules: run pnpm install") : find(path.dirname(dir));
})(project);
const STORE = path.join(project, ".cache/selftest/.spec-cache");
const WEEK = 7 * 24 * 60 * 60 * 1000;
const sharing: string[] = [];
const attempt = (act: () => void) => { try { act(); } catch { return; } };
const toolRuns = (dir: string) => fs.existsSync(dir) ? fs.readdirSync(dir).filter(isActionEntry) : [];
const unused = (root: string, since: number) => toolRuns(path.join(root, ".spec-cache")).filter((f) => fs.statSync(path.join(root, ".spec-cache", f)).mtimeMs < since);
const keepRuns = (from: string, to: string) => {
  for (const name of toolRuns(from)) attempt(() => {
    const [kept, copy] = [path.join(from, name), path.join(to, name)];
    const used = fs.statSync(kept).mtime;
    if (!fs.existsSync(copy)) writeWhole(copy, fs.readFileSync(kept));
    else if (used <= fs.statSync(copy).mtime) return;
    fs.utimesSync(copy, used, used);
  });
};
after(() => {
  for (const root of sharing) keepRuns(path.join(root, ".spec-cache"), STORE);
  for (const name of fs.existsSync(STORE) ? fs.readdirSync(STORE) : []) attempt(() => { if (fs.statSync(path.join(STORE, name)).mtimeMs < Date.now() - WEEK) fs.rmSync(path.join(STORE, name), { force: true }); });
  roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

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
/** `root`, starting with its own copies of the tool runs earlier selftests kept, each as old as its last use, and leaving its own for later ones: only for a test that does not observe a tool running. */
function shared(root: string): string {
  sharing.push(root);
  keepRuns(STORE, path.join(root, ".spec-cache"));
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
function stockQuint(root: string, prelude: string) {
  const originalStore = path.join(nodeModules, ".pnpm");
  const realStore = fs.realpathSync(originalStore);
  const source = fs.realpathSync(path.join(nodeModules, "@informalsystems/quint"));
  const store = path.join(root, "node_modules/.pnpm");
  const directory = path.join(store, path.relative(realStore, source));
  const scope = path.join(root, "node_modules/@informalsystems");
  fs.unlinkSync(store);
  fs.cpSync(path.dirname(path.dirname(source)), path.dirname(path.dirname(directory)), { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
  fs.unlinkSync(scope);
  fs.symlinkSync(path.dirname(directory), scope, "dir");
  const manifest = path.join(directory, "package.json");
  const cli = path.join(directory, JSON.parse(read("package.json", directory)).bin.quint);
  const launcher = path.join(root, "node_modules/.bin/quint");
  fs.writeFileSync(launcher, read(".bin/quint", nodeModules).replaceAll(originalStore, store).replaceAll(realStore, store), { mode: 0o755 });
  const original = fs.readFileSync(cli, "utf8");
  fs.writeFileSync(cli, original.replace(/^#![^\n]*\n/, (shebang) => `${shebang}"use strict";\n${prelude}\n`));
  return { directory, manifest, cli };
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

// The order example with whatever awaits sign-off here accepted, checked once before the tests that copy it
// so that every copy starts with its cache: an edit then re-runs only what it changes.
const pristine = shared(scratch({}));

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
async function run(root: string, accept: false | "reviews" | "unproved" = false, log?: (result: Result) => void) {
  const { results, next } = await check(root, accept, log);
  const text = results.map(show).join("\n");
  return {
    text,
    next,
    results,
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
/** `spec watch` of a project: what it has printed, a wait for what it prints next while it runs, and a stop. */
function watching(root: string, cwd = root) {
  const watcher = spawn(process.execPath, [path.join(project, "vibestack/spec.ts"), "watch", root], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const said = { output: "" };
  for (const stream of [watcher.stdout, watcher.stderr]) stream.on("data", (chunk) => { said.output += chunk; });
  return {
    said,
    checks: () => said.output.match(/watching what the check reads/g)?.length ?? 0,
    waitFor: (ready: () => boolean) => until(() => { assert.equal(watcher.exitCode, null, said.output); return ready(); }, () => said.output),
    stop: async () => {
      if (watcher.exitCode !== null || watcher.signalCode !== null) return;
      const closed = new Promise((resolve) => watcher.once("close", resolve));
      watcher.kill("SIGTERM");
      await closed;
    },
  };
}
/** What `check --json` ends with: the whole answer, after a line for each result. */
const answer = (stdout: string) => JSON.parse(stdout.trimEnd().split("\n").at(-1)!);
const unguarded = (s: string) => s.replace("o.status == Draft and o.units > 0", "o.status == Draft");
const notInductive = (s: string) => s.replace(/### Drafts and cancelled orders hold no money[\s\S]*?```\n\n/, "");

function eachCheckA() {
  test("collection operations preserve structural equality, total lookups and exact integer results", async () => {
    const forged = oneRule("forged", "Forged builtin", "pure def std_getOr_forged(m: int -> int, key: int, fallback: int): int = 42\npure def readMap(m: int -> int): int = std_getOr_forged(m, 1, 0)");
    assert.throws(() => parseSpec(forged, "spec/forged.md"), /forged\.md:8: a name beginning std_ is reserved for generated collection operations/);
    // A fold marked by hand would otherwise be printed as the list helper the mark names.
    assert.throws(() => parseSpec(forged, "spec/forged.md", ruleSpec("pure def anyPositive(xs: List[int]): bool = xs.foldl(false, (std_some_0, x) => x > 0)")), /forged\.md:8: a name beginning std_/);
    assert.doesNotThrow(() => parseSpec(forged, "spec/forged.md", ruleSpec('// std_some_0\npure val standard = "std_some_0"')));
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

  test("variant set literals keep their element type in conditional unions and local bindings", async () => {
    const root = oneRule("fields", "Evidence fields", `type Field = First | Second
pure val common: Set[Field] = Set(First)
pure def required(includeSecond: bool): Set[Field] = common.union(if (includeSecond) Set(Second) else Set())
pure def selected(which: bool): Set[Field] = {
  val choices = if (which) Set(First) else Set(Second)
  choices.union(Set(Second))
}`);
    const model = await gen(root, parseSpec(root, "spec/fields.md"));
    const checked = await tool("vibelang", ["--noEmit", "--strict", "--target", "es2023", "gen/fields.ts"], root);
    assert.ok(checked.ok, checked.out);
    const proof = model.render("");
    assert.ok(proof.includes('includeSecond ? ([typed0_fields("Second")] as Field[]) : ([] as Field[])'));
    const domain = await import(pathToFileURL(path.join(root, "gen", "fields.ts")).href);
    assert.deepEqual([domain.required(true), domain.required(false)], [["First", "Second"], ["First"]]);
    assert.deepEqual([domain.selected(true), domain.selected(false)], [["First", "Second"], ["Second"]]);
  });

  test("the explore stage finds a page that breaks a property, keeps the trace, replays it first, and drops it once fixed", { skip: !["linux-x64", "linux-arm64", "darwin-arm64"].includes(`${process.platform}-${process.arch}`) }, async () => {
    if (process.env.TURBO_HASH && hostedCachedFixture()) await installChromium("full");
    const remember: Parameters<typeof explore>[1] = (_fingerprint, run) => run();
    const page = (script: string) => `<!doctype html><html><head><title>Page</title></head><body><button>Go</button>${script}</body></html>`;
    const server = 'import http from "node:http"; import fs from "node:fs";\nconst app = http.createServer((_, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(fs.readFileSync("index.html")); });\napp.listen(0, "127.0.0.1", () => console.log(`Local: http://localhost:${app.address().port}/`));\n';
    const manifest = (scripts: Record<string, string>) => JSON.stringify({ name: "page", private: true, type: "module", packageManager: "pnpm@10.24.0", scripts });
    assert.deepEqual(await explore(scratch({ "package.json": manifest({ start: "node server.js" }) }), remember), []);
    const [unserved, silent] = await Promise.all([
      explore(scratch({ "package.json": manifest({ build: "true" }), "index.html": page("") }), remember),
      explore(scratch({ "package.json": manifest({ start: "node -e \"console.log('starting')\"" }), "index.html": page(""), "src/main.ts": 'import "../../";' }), () => assert.fail("an enclosing import must exercise the server again")),
    ]);
    assert.deepEqual(unserved.map(([ok, stage, summary]) => [ok, stage, summary]), [[false, "explore", "index.html is a page, and package.json has no start or dev script that serves it: add one that prints the address it serves at"]]);
    assert.deepEqual(silent.map(([ok, stage]) => [ok, stage]), [[false, "explore"]]);
    assert.match(silent[0][2], /`pnpm run start` printed no http:\/\/localhost address before it ended/);
    const root = scratch({ "package.json": manifest({ start: "node server.js" }), "server.js": server, "index.html": page('<script>throw new Error("broken on load")</script>') });
    const saved = path.join(root, "test/__traces__/bombadil");
    const broken = await explore(root, remember);
    assert.deepEqual(broken.map(([ok, stage]) => [ok, stage]), [[false, "explore"]], broken.map((r) => r.join("\n")).join("\n"));
    assert.match(broken[0][2], /^index\.html: the page breaks noUncaughtExceptions/);
    assert.ok(fs.existsSync(saved));
    const replayed = await explore(root, remember);
    assert.deepEqual(replayed.map(([ok, stage]) => [ok, stage]), [[false, "explore"]], replayed.map((r) => r.join("\n")).join("\n"));
    assert.match(replayed[0][2], /still breaks, in the replay of test\/__traces__\/bombadil, noUncaughtExceptions/);
    const unavailable = await exec(process.execPath, ["--input-type=module", "-e",
      `import { explore } from ${JSON.stringify(path.join(project, "vibestack/explore.ts"))}; process.stdout.write(JSON.stringify(await explore(process.cwd(), (_key, run) => run())));`],
    root, { ...process.env, CHROME: process.execPath });
    assert.equal(unavailable.status, 0, unavailable.stderr);
    assert.match(unavailable.stdout, /is kept, to be replayed when it can be/);
    assert.ok(fs.existsSync(saved));
    fs.writeFileSync(path.join(root, "index.html"), page(""));
    toolchain(root);
    const fixtureModule = pathToFileURL(path.join(root, "vibestack/explore.ts")).href;
    const realBombadil = path.join(nodeModules, ".bin/bombadil");
    const normalBudget = `${profile("normal").explore}s`;
    const receivedBudget = path.join(root, "explore-budget");
    fs.writeFileSync(path.join(root, "node_modules/.bin/bombadil"), `#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const launch = (argv) => {
  const result = spawnSync(${JSON.stringify(realBombadil)}, argv, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
};
import(${JSON.stringify(fixtureModule)}).then(({ explored }) => {
  const limit = args.indexOf("--time-limit");
  const isReplay = args.includes("--reproduce");
  if (isReplay) {
    assert.equal(limit, -1);
  } else {
    assert.notEqual(limit, -1);
    assert.equal(args[limit + 1], ${JSON.stringify(normalBudget)});
    assert.ok(args.includes("--exit-on-violation"));
    fs.writeFileSync(${JSON.stringify(receivedBudget)}, args[limit + 1]);
  }
  let result = launch(isReplay ? args : args.toSpliced(limit + 1, 1, "12s"));
  if (!isReplay && result.status === 0 && explored(0, result.stdout, result.stderr, false).kind === "failed") result = launch(args);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
});
`, { mode: 0o755 });
    const { explore: fixtureExplore }: { explore: typeof explore } = await import(fixtureModule);
    const fixed = await fixtureExplore(root, remember);
    assert.equal(read("explore-budget", root), normalBudget);
    assert.deepEqual(fixed.map((r) => r.slice(0, 2)), [[true, "explore"], [true, "explore"]], fixed.map((r) => r.join("\n")).join("\n"));
    assert.match(fixed[1][2], /\b[1-9]\d* actions in \d+ s broke no property/);
    assert.match(fixed[0][2], /the replay of test\/__traces__\/bombadil (breaks nothing now|no longer applies to the page), so it was removed/);
    assert.ok(!fs.existsSync(saved));
    assert.ok(!fs.existsSync(path.join(root, "test")), "an exploration leaves no test/ behind for the next check to give Vitest");
  });

  test("what Bombadil prints is read as a pass, a broken property, a replay that no longer applies, or why it could not explore", () => {
    const run = "00:00.512 Clicking <button> (x: 10.0, y: 20.0)\n00:01.020 Reloading page\n";
    assert.deepEqual(explored(0, run, "", false), { kind: "held", actions: 2 });
    assert.deepEqual(explored(0, "", "", true), { kind: "held", actions: 0 });
    assert.match((explored(0, "Test finished after time limit!", "", false) as { why: string }).why, /^Bombadil took no action/);
    const broken = explored(2, `${run}\nnoConsoleErrors was violated:\n\nas of 00:00.000, it should always be the case that …\n\nTest finished, finding 1 violation!\n`, "", false);
    assert.deepEqual(broken.kind === "broke" && broken.properties, ["noConsoleErrors"]);
    assert.match((broken as { report: string }).report, /Reloading page\n\nnoConsoleErrors was violated:/);
    assert.match((explored(1, "", "Error: failed to locate chromium/chrome executable", false) as { why: string }).why, /^Bombadil found no Chromium: run `pnpm exec playwright install chromium`/);
    assert.match((explored(1, "", "Error: failed to locate chromium/chrome executable", true) as { why: string }).why, /^Bombadil found no Chromium/);
    assert.match((explored(1, "Test stopped after the browser stalled!", "", false) as { why: string }).why, /^the browser stalled/);
    assert.deepEqual(explored(1, "", "Error: reproduction and original test diverged!", true).kind, "diverged");
    for (const output of ["Error: browser disconnected", "Test stopped after the browser stalled!", "Error: could not read trace"]) {
      assert.equal(explored(1, "", output, true).kind, "failed");
    }
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
    if (process.platform !== "win32") {
      const driver = `let state = 0;
export const options = { keys: ["counter"], walks: 1, steps: 1 };
export const driver = {
  reset() { state = 0; },
  dispatch() { if (state === 2) return "refused"; state++; return "accepted"; },
  observe() { return state; },
};`;
      const file = path.join(root, "test/drivers/counter.ts");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.symlinkSync(nodeModules, path.join(root, "node_modules"), "dir");
      const checkDriver = async (source: string) => {
        fs.writeFileSync(file, source);
        const kept: boolean[] = [];
        const [result] = await checkTraces(root, machines, {}, async (_, run, keep) => {
          const value = await run();
          kept.push(keep(value));
          return value;
        }, new Map());
        return { result, kept };
      };
      const passed = await checkDriver(driver);
      assert.ok(passed.result[0] && passed.result[2].includes("1 walks of seed 1"), passed.result.join("\n"));
      assert.deepEqual(passed.kept, [true]);
      const stopped = await checkDriver(`${driver}\nprocess.on("exit", () => process.kill(process.pid, "SIGKILL"));`);
      assert.equal(stopped.result[0], false, stopped.result.join("\n"));
      assert.match(stopped.result[3] ?? "", /did not finish: node was killed by SIGKILL[\s\S]*"summary":"1 walks of seed 1"/);
      assert.deepEqual(stopped.kept, [false]);
      const disagreement = await checkDriver(driver.replace("return state;", "return state + 1;"));
      assert.equal(disagreement.result[0], false, disagreement.result.join("\n"));
      assert.match(disagreement.result[2], /the program departs from the spec/);
      assert.deepEqual(disagreement.kept, [false]);
      fs.rmSync(file);
    }
    const departs = async () => (await checkTraces(root, machines, packageScripts(root), (_, ran) => ran(), new Map())).filter(([ok]) => !ok).map(([, , summary, detail]) => `${summary}\n${detail}`);
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

  test("a fresh spec with enum and bool parameters and mixed guarded and unguarded transitions passes everything but review", async () => {
    const guarded = [
      true, true, true, true, true,
      false,
      true, true, true, true, true,
      false, false,
      true, true, true, true, true,
      false, false, false,
    ];
    const root = fixtures(["door"], (files) => {
      const transitions = guarded.map((hasGuard, i) => {
        const guard = hasGuard ? `pure def canSetAlarm${i + 1}(d: Door, on: bool): bool = d.alarm != on\n` : "";
        return `${guard}pure def setAlarm${i + 1}(d: Door, on: bool): Door = { ...d, alarm: on }`;
      }).join("\n");
      files["spec/door.md"] += `\n### Alarm variants retain their own admission\n\n${F}quint\n${transitions}\n${F}\n`;
    });
    const { failed, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
    const log = fs.readFileSync(path.join(root, "gen/proof/door.log"), "utf8");
    assert.match(log, /Dafny auditor completed/);
    assert.doesNotMatch(log, /every assertion isolated/, "a unit that proves whole is not verified again");
    const door = await import(path.join(root, "gen/door.ts"));
    assert.equal(door.step(door.initial, { type: "move", target: "Closed" }), door.initial);
    assert.deepEqual(door.step(door.initial, { type: "setAlarm21", on: true }), { ...door.initial, alarm: true });
    assert.equal(door.parseEvent({ type: "unknown" }), undefined);
    assert.equal(door.step(door.initial, { type: "unknown" }), door.initial);
  });

  test("a missing guard is found by simulation, as a trace that the same seed gives again and that is remembered, and the later stages say they were skipped", async () => {
    const root = copyOfProject("spec/index.md", unguarded);
    fs.writeFileSync(path.join(root, "spec/index.proof.dfy"), "lemma overlapsTheSimulation()\n  ensures true\n{\n}\n");
    fs.rmSync(path.join(root, "gen/proof"), { recursive: true, force: true });
    const first = await run(root);
    assert.ok(fs.existsSync(path.join(root, "gen/traces")), "a simulation that ran leaves its traces until the next check");
    assert.deepEqual(first.results.filter((r) => r.stage === "proof" || r.stage === "types"), [], first.text);
    assert.match(read("gen/proof/index/index.dfy", root), /lemma overlapsTheSimulation/, "the proofs that ran beside the failing simulation finished before the check returned");
    assert.ok(fs.existsSync(path.join(root, "gen/proof/index.log")), first.text);
    fs.rmSync(path.join(root, ".spec-cache"), { recursive: true });
    const [again, remembered] = [await run(root), await run(root)];
    const trace = first.said("always", /./);
    assert.equal(trace?.ok, false, first.text);
    assert.match(trace!.detail, /seed \d+; to simulate again: pnpm exec quint run gen\/index\.run\.qnt .* --seed \d+/);
    assert.equal(again.said("always", /./)?.detail, trace!.detail, "the same harness gives the same trace");
    assert.equal(remembered.said("always", /./)?.detail, trace!.detail);
    assert.ok(!fs.existsSync(path.join(root, "gen/traces")), "a failing simulation is not run again for the same harness");
    assert.ok(first.said("skipped", /^types, proof, tests, traces and explore: /), first.text);
    assert.match(first.next, /^always \(spec\/index\.md\) is the first ✗/);
    // The nightly profile is part of what is remembered and simulates a different, reproducible set of traces.
    const fuzzed = await exec(process.execPath, [path.join(project, "vibestack/spec.ts"), "check", "--json", "--nightly"], root);
    const seeded = answer(fuzzed.stdout).results.find((r: Result) => r.stage === "always").detail;
    assert.match(seeded, /seed \d+; to simulate again/);
    assert.notEqual(seeded.match(/seed (\d+)/)[1], trace!.detail.match(/seed (\d+)/)![1]);
    const repeated = await exec(process.execPath, [path.join(project, "vibestack/spec.ts"), "check", "--json", "--nightly"], root);
    assert.equal(answer(repeated.stdout).results.find((r: Result) => r.stage === "always").detail, seeded);
    assert.equal((await run(root)).said("always", /./)?.detail, trace!.detail, "the normal profile retains its own seed and remembered result");
  });

  test("Quint's violation on stderr counts, while the same text in a failed run's state does not", async () => {
    const quiet = toolchain(oneRule("index", "The counter stays zero", [
      "pure val initial: int = 0",
      "pure def increment(n: int): int = n + 1",
      "pure def alwaysZero(n: int): bool = n == 0",
    ].join("\n")), "quint");
    const win = process.platform === "win32";
    const relative = path.join(".bin", win ? "quint.cmd" : "quint");
    const bin = path.join(quiet, "node_modules", relative);
    const quint = path.join(nodeModules, relative);
    fs.unlinkSync(bin);
    fs.writeFileSync(bin, win
      ? `@if "%~1"=="run" (call "${quint}" %* --verbosity 0) else (call "${quint}" %*)\r\n`
      : `#!/bin/sh\nif [ "$1" = run ]; then set -- "$@" --verbosity 0; fi\nexec '${quint.replaceAll("'", "'\\''")}' "$@"\n`,
    { mode: 0o755 });
    const witness = await runCli(path.join(quiet, "vibestack/spec.ts"), quiet, "check", "--json");
    const broken = answer(witness.stdout).results.find((r: Result) => r.stage === "always");
    assert.match(broken?.summary ?? "", /a reachable state breaks/, witness.stdout + witness.stderr);
    assert.match(broken?.detail ?? "", /increment\s+-> state = 1/);

    const runtime = await run(oneRule("index", "The counter can be checked", [
      "type Counter = { count: int, message: str }",
      'pure val initial: Counter = { count: 0, message: "error: Invariant violated" }',
      "pure def increment(c: Counter): Counter = { count: c.count + 1, message: c.message }",
      "pure def alwaysChecked(c: Counter): bool = if (c.count == 0) true else c.count / (c.count - c.count) == 1",
    ].join("\n")));
    const error = runtime.said("always", /the simulator could not run/);
    assert.match(error?.detail ?? "", /message: "error: Invariant violated"[\s\S]*Division by zero/, runtime.text);
  });

  test("a guardless event that breaks a rule and that other transitions call is named as a helper taken for an event", async () => {
    const helper = await run(oneRule("index", "The counter stays zero", [
      "pure val initial: int = 0",
      "pure def bump(n: int): int = n + 1",
      "pure def canIncrement(n: int): bool = false",
      "pure def increment(n: int): int = bump(n)",
      "pure def alwaysZero(n: int): bool = n == 0",
    ].join("\n")));
    assert.match(helper.said("always", /a reachable state breaks/)?.detail ?? "", /bump\s+-> state = 1[^]*; it has no guard\n\s+increment calls it, so it may be a helper taken for an event/, helper.text);
  });

  test("a rule set that holds in simulation but is not inductive is caught by the proof, and the deleted rule awaits review", async () => {
    const { failed, said, text } = await run(copyOfProject("spec/index.md", notInductive));
    assert.deepEqual(failed, ["proof", "review"], text);
    assert.ok(said("review", /removed or renamed/), text);
  });

  test("rules too strict to ever reach a goal are caught by a `sometimes` rule", async () => {
    const { failed, said, text } = await run(shared(fixtures(["lamp"], (f) => { f["spec/lamp.md"] = f["spec/lamp.md"].replace("l.mode == On\n", "l.mode == On and l.flips == 0\n"); })));
    assert.ok(failed.includes("sometimes"), text);
    assert.ok(said("sometimes", /\(spec\/lamp\.md:\d+\) was not reached in /), text);
  });

  test("a guard that never allows its event is caught, although every rule holds of the event trivially, and one that needs values the simulator does not try says which to define", async () => {
    const { failed, text, said } = await run(shared(fixtures(["account", "bank"], (f) => {
      f["spec/bank.md"] = f["spec/bank.md"].replace("pure def canSpend(b: Bank, amount: int): bool = ", "pure def canClose(b: Bank): bool = total(b) > 6\npure def close(b: Bank): Bank = b\n\npure def canSpend(b: Bank, amount: int): bool = amount > 6 and ");
    })));
    assert.ok(failed.includes("sometimes"), text);
    assert.ok(said("sometimes", /\bclose in .* never happened: its guard canClose refused it/), text);
    assert.ok(said("sometimes", /\bspend in .* never happened: .*define amountValues/), text);
    assert.ok(!/\bsave in .* never happened/.test(text), text);
  });

  test("a shared scratch project starts with the tool runs an earlier one kept and runs none of them again, and the copies of the order project carry only the runs it used", async () => {
    const began = Date.now() - 1000;
    const first = shared(fixtures(["door"]));
    assert.deepEqual((await run(first)).failed, ["review"]);
    keepRuns(path.join(first, ".spec-cache"), STORE);
    const second = shared(fixtures(["door"]));
    const runs = toolRuns(path.join(first, ".spec-cache")).filter((f) => !unused(first, began).includes(f));
    assert.ok(runs.length > 0 && runs.every((f) => fs.readFileSync(path.join(second, ".spec-cache", f)).equals(fs.readFileSync(path.join(STORE, f)))), runs.join());
    const again = await run(second);
    assert.deepEqual(again.failed, ["review"], again.text);
    assert.ok(!fs.existsSync(path.join(second, "gen/traces")) && !["gen", "check", "verify", "audit"].some((ran) => fs.existsSync(path.join(second, "gen/proof/door", ran))), again.text);
    assert.deepEqual(unused(pristine, fs.statSync(path.join(pristine, "tsconfig.json")).mtimeMs - 1000), [], "the order project keeps no run older than itself");
  });

  test("a formal cache survives a disposable project and keeps changed models fresh", async () => {
    const cache = path.join(scratch({}), "formal-cache");
    const first = fixtures(["door"]);
    const initial = await withFormalCache(cache, () => run(first));
    assert.deepEqual(initial.failed, ["review"], initial.text);
    assert.ok(fs.existsSync(path.join(first, "gen/traces")), initial.text);
    const entries = fs.readdirSync(cache);
    assert.ok(entries.length > 0 && entries.every((file) => isActionEntry(file) && file.endsWith(".zst")));
    const primary = path.join(cache, entries[0]);
    fs.writeFileSync(primary.replace(/\.zst$/, ".gz"), gzipSync(zstdDecompressSync(fs.readFileSync(primary))));
    fs.rmSync(primary);
    fs.rmSync(first, { recursive: true, force: true });

    const same = fixtures(["door"]);
    const changed = fixtures(["door"], (files) => {
      files["spec/door.md"] = files["spec/door.md"].replace("pure def canMove", "pure def !canMove");
    });
    const [repeated, updated] = await Promise.all([
      withFormalCache(cache, () => run(same)),
      withFormalCache(cache, () => run(changed)),
    ]);
    assert.deepEqual(repeated.results, initial.results);
    assert.ok(!fs.existsSync(primary), "the shared legacy action was reused");
    assert.ok(!fs.existsSync(path.join(same, "gen/traces")), repeated.text);
    assert.ok(!fs.existsSync(path.join(same, "gen/proof/door/verify")), repeated.text);
    assert.ok(updated.failed.includes("model"), updated.text);
  });

  test("selected simulations warm the ordinary check in another project and reject failed inputs", async () => {
    const cache = path.join(scratch({}), "formal-cache");
    const seedParent = scratch({});
    const sources = {
      "spec/base.md": ruleSpec("pure val limit = 2"),
      "spec/limit.md": ruleSpec('import base as B from "./base"\npure val top = B::limit'),
      "spec/counter.md": ruleSpec('import limit as L from "./limit"\npure val initial: int = 0\npure def canInc(n: int): bool = n < L::top\npure def inc(n: int): int = n + 1\npure def alwaysBounded(n: int): bool = n <= L::top\npure def sometimesFull(n: int): bool = n == L::top'),
      "spec/other.md": ruleSpec("pure val initial: int = 0\npure def bump(n: int): int = n + 1\npure def alwaysNonnegative(n: int): bool = n >= 0"),
    };
    const selected = ["other", "counter", "other"];
    const simulations = (project: string, names = selected) => withFormalCache(cache, () => precomputeSimulations(project, readSpecs(project), names));
    const prepare = (project: string, names = selected) => withFormalCache(cache, () => prepareSimulationReceipts(project, readSpecs(project), names, seedParent));
    const invalid = ruleSpec("pure val bad = unknownValue");
    const first = scratch({ ...sources, "spec/untouched.md": invalid });
    const { results: cold, seedDirectory: coldSeed, partialDirectory: coldPartial } = await prepare(first);
    assert.equal(coldPartial, undefined);
    assert.deepEqual([...new Set(cold.map((row) => row.where))], ["spec/other.md", "spec/counter.md"]);
    assert.ok(cold.every((row) => row.ok) && cold.some((row) => row.stage === "sometimes"), JSON.stringify(cold));
    assert.ok(cold.some((row) => row.stage === "replay" && row.where === "spec/counter.md"), JSON.stringify(cold));
    assert.ok(fs.readdirSync(path.join(first, "gen/traces")).some((dir) => dir.startsWith("counter.")));
    assert.ok(!fs.existsSync(path.join(first, "gen/counter.ts")), "partial precomputation does not publish generated modules");
    const receipts = fs.readdirSync(cache);
    assert.ok(receipts.length > 0 && receipts.every(isActionEntry));
    assert.ok(coldSeed);
    const names = fs.readdirSync(coldSeed);
    assert.equal(names.filter(isActionEntry).length, 4);
    assert.equal(names.filter((name) => name.startsWith("simulate-")).length, 2);
    assert.equal(names.length, 6);
    fs.rmSync(first, { recursive: true, force: true });

    const same = scratch(sources);
    const warm = await withFormalCache(cache, () => run(same));
    assert.deepEqual(warm.results.filter(({ stage }) => ["always", "sometimes", "replay"].includes(stage)),
      [...cold].sort((a, b) => a.where!.localeCompare(b.where!)));
    assert.ok(!fs.existsSync(path.join(same, "gen/traces")), "ordinary check reused every simulation action");
    assert.ok(receipts.every((file) => fs.existsSync(path.join(cache, file))));

    const changedSources = { ...sources, "spec/base.md": sources["spec/base.md"].replace("= 2", "= -1") };
    const changed = scratch(changedSources);
    const rejected = await prepare(changed);
    assert.ok(rejected.results.some((row) => row.where === "spec/counter.md" && row.stage === "always" && !row.ok && row.detail.includes("initial")), JSON.stringify(rejected));
    assert.ok(rejected.results.some((row) => row.where === "spec/other.md" && row.stage === "replay" && row.ok), JSON.stringify(rejected));
    assert.equal(rejected.seedDirectory, undefined);
    const partial = rejected.partialDirectory;
    assert.ok(partial);
    const partialNames = fs.readdirSync(partial);
    assert.deepEqual([partialNames.filter(isActionEntry).length, partialNames.filter((name) => name.startsWith("simulate-")).length, partialNames.length], [4, 2, 6]);
    assert.equal(fs.readdirSync(seedParent).length, 2);
    fs.rmSync(changed, { recursive: true, force: true });

    const mixed = scratch(changedSources);
    fs.cpSync(partial, path.join(mixed, ".spec-cache"), { recursive: true });
    const received = await run(mixed);
    assert.deepEqual(received.results.filter(({ stage }) => ["always", "sometimes", "replay"].includes(stage)),
      [...rejected.results].sort((a, b) => a.where!.localeCompare(b.where!)));
    assert.ok(received.failed.includes("always"), received.text);
    assert.ok(!fs.existsSync(path.join(mixed, "gen/traces")), "the ordinary check reused the mixed simulation receipts");

    const typecheck = names.find(isActionEntry);
    assert.ok(typecheck);
    const legacy = typecheck.replace(/\.zst$/, ".gz");
    assert.notEqual(legacy, typecheck);
    fs.writeFileSync(path.join(cache, legacy), gzipSync(zstdDecompressSync(fs.readFileSync(path.join(cache, typecheck)))));
    fs.rmSync(path.join(cache, typecheck));
    const warmProducer = scratch(sources);
    fs.cpSync(coldSeed, path.join(warmProducer, ".spec-cache"), { recursive: true });
    const prepared = await prepare(warmProducer);
    assert.deepEqual(prepared.results, cold);
    const seed = prepared.seedDirectory;
    assert.ok(seed && seed !== coldSeed);
    assert.deepEqual(fs.readdirSync(seed).sort(), [...names.filter((name) => name !== typecheck), legacy].sort());
    assert.deepEqual(fs.readFileSync(path.join(seed, legacy)), fs.readFileSync(path.join(cache, legacy)));

    const compact = scratch(sources);
    fs.cpSync(seed, path.join(compact, ".spec-cache"), { recursive: true });
    assert.deepEqual((await run(compact)).results, warm.results);
    assert.ok(!fs.existsSync(path.join(compact, "gen/traces")), "the ordinary check reused the compact seed");

    const fallback = scratch(sources);
    const restored = path.join(fallback, ".spec-cache");
    fs.cpSync(seed, restored, { recursive: true });
    const damaged = names.find((name) => name.startsWith("simulate-"));
    assert.ok(damaged);
    fs.writeFileSync(path.join(restored, damaged), "truncated receipt");
    assert.deepEqual((await run(fallback)).results, warm.results);
    assert.ok(fs.existsSync(path.join(fallback, "gen/traces")), "the ordinary check recomputed a damaged result");

    const malformed = scratch({ ...sources, "spec/untouched.md": invalid,
      "spec/other.md": sources["spec/other.md"].replace("n + 1", "n + 2") });
    await assert.rejects(simulations(malformed, ["other", "untouched"]), /spec\/untouched.md[^]*unknownValue/);
    const traces = path.join(malformed, "gen/traces");
    assert.ok(fs.readdirSync(traces).some((dir) => dir.startsWith("other.inv.probe")), "the already started simulation reached the probe before rejection");
    assert.ok(!fs.existsSync(path.join(malformed, ".spec-cache/lock")));
    assert.ok((await simulations(malformed, ["other"])).every((row) => row.ok));
    await assert.rejects(simulations(same, ["missing"]), /no spec has the module name "missing"/);
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
      ["parameter named like a variant", (s) => s.replace("pure def canCancel(", "pure def isIt(o: Order, Draft: Status): bool = o.status == Draft\npure def canCancel(")],
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
      ["a parameter named like a word Dafny reserves and LemmaScript does not rename", "pure val initial: int = 0\npure def f(assigned: int): int = assigned", /`assigned` cannot be used as a name/],
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
    assert.equal(gen.step(gen.initial, { type: "open" }, "Guest"), gen.initial);
    assert.equal(gen.step(gen.initial, { type: "open" }, "Owner").open, true);
    assert.equal(gen.parseSender("Owner"), "Owner");
    assert.equal(gen.parseSender("Mallory"), undefined);
    // The traces stage knows the spec's events come from someone.
    assert.match(departure(gen, { sender: true } as never, [{ event: { type: "open" }, by: "Mallory", state: gen.initial }])?.why ?? "", /valid sender/);
    assert.equal(gen.step(gen.initial, { type: "relabel", label: "a" }, "Owner").label, "a");
    // A counterexample shows each event with only what it changed.
    // `close` takes no sender, but is still sent by someone, and the counterexample says by whom.
    assert.ok(broken.said("always", /a step breaks[\s\S]*\n\s+close\{"by":"(Owner|Guest)"\}\s+-> open = true\n/), broken.text);
    assert.ok(stray.said("model", /canRelabel: `who` must be a parameter of relabel/), stray.text);
  });

  test("once any transition takes a sender, every simulated event has one, the same seed gives the same senders, and the journeys and walks pass conformance", async () => {
    // The vault's `open` takes `by` and its `close` and `tick` do not (SPEC.md: then every event takes a sender).
    const root = fixtures(["vault"]);
    const spec = parseSpec(root, "spec/vault.md");
    const model = await gen(root, spec);
    const domain = await import(path.join(root, "gen/vault.ts"));
    const harness = () => ({ memory: { root, fresh: true, used: new Set<string>() }, model, files: harnessFiles(spec, [spec], model) });
    // One after the other: both write the same directory of gen/traces.
    const { traces } = await simulate(harness(), "inv", 20, 200);
    const again = await simulate(harness(), "inv", 20, 200);
    const events = (ts: typeof traces) => ts.flat().flatMap((s) => (s.event ? [s.event as Record<string, unknown>] : []));
    assert.ok(["open", "close", "tick"].every((type) => events(traces).some((e) => e.type === type)), JSON.stringify(events(traces)));
    for (const e of events(traces)) assert.notEqual(domain.parseSender(e.by), undefined, `${JSON.stringify(e)} has no valid sender`);
    assert.deepEqual(events(again.traces), events(traces), "the same seed gives the same events and senders");
    // A journey to the vault opened, taken from a trace, and the same events in walks, against a driver that does what the spec does.
    const trace = traces.find((t) => t.some((s) => (s.state as { open: boolean } | undefined)?.open))!;
    const journey = trace.slice(0, trace.findIndex((s) => (s.state as { open: boolean } | undefined)?.open) + 1);
    const found = conformanceFound(model, spec, traces, [{ w: "sometimesOpen", trace: journey }]);
    assert.ok(found.sender && found.journeys[0].events.length && found.journeys[0].events.every((e) => domain.parseSender(e.by) !== undefined), JSON.stringify(found.journeys));
    const held = new Map<string, unknown>();
    const following = {
      reset: () => held.clear(),
      dispatch: (key: string, event: unknown, by: unknown) => {
        const state = held.get(key) ?? domain.initial;
        if (!domain.enabled(state, event, by)) return "refused" as const;
        held.set(key, domain.step(state, event, by));
        return "accepted" as const;
      },
      observe: (key: string) => held.get(key) ?? domain.initial,
    };
    const result = await conformanceCheck(domain, found, following, { walks: 3, steps: 10 });
    assert.equal(result.journeys, 1);
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

  test("an explicitly reached probe goal keeps the independent search that exposes a broken rule", async () => {
    const root = oneRule("counter", "The counter stays under 22", `pure val initial: int = 0
pure val choiceValues = Set(${Array.from({ length: 64 }, (_, i) => i).join(", ")})
pure def advance(n: int, choice: int): int = if (n == -1 or (n == 0 and choice == 0)) -1 else n + 1
pure def alwaysBelowTwentyTwo(n: int): bool = n < 22
pure def sometimesExit(n: int): bool = n == -1`);
    const result = await run(root);
    const broken = result.said("always", /a reachable state breaks/);
    assert.ok(broken && !broken.ok, result.text);
    assert.match(broken.detail, /-> state = 22\b/);
    assert.match(broken.detail, /never_sometimesExit .*--max-steps 40/);
    assert.ok(!result.said("sometimes", /is reachable/), result.text);
    assert.ok(result.said("skipped", /^types, proof,/), result.text);
    const probe = fs.globSync("gen/traces/counter.inv.probe/**/*.itf.json", { cwd: root });
    assert.ok(probe.some((file) => JSON.parse(read(file, root)).states.some((s: Record<string, unknown>) =>
      s["mbt::actionTaken"] === "eval_sometimesExit" && isDeepStrictEqual(s.outcome, { tag: "Out_sometimesExit", value: true }))));
  });

  test("a deeper reachable goal does not preempt a shallow safety counterexample", async () => {
    const root = oneRule("rare", "Find a rare choice after counting", `pure val initial: int = 0
pure val pValues = 0.to(127)
pure val qValues = 0.to(127)
pure def up(n: int, p: int, q: int): int = if (n == 0 and p == 109 and q == 71) -2 else if (n == 38 and p < 16 and q < 6) -1 else n + 1
pure def alwaysSafe(n: int): bool = n >= -1
pure def sometimesMarked(n: int): bool = n == -1`);
    const result = await run(root);
    const broken = result.said("always", /a reachable state breaks/);
    assert.ok(broken && !broken.ok, result.text);
    assert.match(broken.detail, /-> state = -2\b/);
    assert.match(broken.detail, /never_sometimesMarked .*--max-samples 200000 --max-steps 20\b/);
    assert.ok(!result.said("sometimes", /is reachable/), result.text);
    assert.ok(result.said("skipped", /^types, proof,/), result.text);
  });

  test("a deep witness is found in the short sweep before the full search", async () => {
    const quint = "pure val initial: int = 0\npure def up(n: int): int = n + 1\npure def sometimesLate(n: int): bool = n == 38";
    const root = oneRule("t", "Counting", quint);
    const spec = readSpecs(root)[0];
    const model = await gen(root, spec);
    const result = await search({ memory: { root, fresh: true, used: new Set() }, model, files: harnessFiles(spec, [spec], model) }, "never_sometimesLate", "step", [20, 40], 180);
    assert.equal(result.broken, true, result.again);
    assert.match(result.again, /--max-samples 32 --max-steps 40\b/);
    assert.equal(result.traces[0]?.at(-1)?.state, 38);

    const rare = oneRule("rare", "Find a rare choice after counting", [
      "pure val initial: int = 0",
      "pure def up(n: int): int = n + 1",
      "pure val tokenValues = 1.to(300)",
      "pure def canMark(n: int, token: int): bool = n == 38 and token == 1",
      "pure def mark(n: int, token: int): int = -1",
      "pure def sometimesMarked(n: int): bool = n == -1",
    ].join("\n"));
    const rareModel = await gen(rare, readSpecs(rare)[0]);
    const found = await search({ memory: { root: rare, fresh: true, used: new Set() }, model: rareModel, files: harnessFiles(readSpecs(rare)[0], readSpecs(rare), rareModel) }, "never_sometimesMarked", "step", [20, 40], 4096);
    assert.equal(found.broken, true, found.again);
    assert.match(found.again, /--max-samples 2048 --max-steps 40\b/);
    assert.equal(found.traces[0]?.at(-1)?.state, -1);

    const lateGuard = oneRule("gate", "Allow completion after counting", [
      "pure val initial: int = 0",
      "pure def up(n: int): int = n + 1",
      "pure def canFinish(n: int): bool = n >= 38",
      "pure def finish(n: int): int = 0",
    ].join("\n"));
    const guardModel = await gen(lateGuard, readSpecs(lateGuard)[0]);
    const allowed = await search({ memory: { root: lateGuard, fresh: true, used: new Set() }, model: guardModel, files: { ...harnessFiles(readSpecs(lateGuard)[0], readSpecs(lateGuard), guardModel), "gate.guard.run.qnt": { text: guardModel.guardHarness, key: guardModel.guardHarness } }, main: "gate.guard.run.qnt" }, "never_allows_canFinish", "eval_canFinish__1", [20, 40], 180);
    assert.match(allowed.again, /--step eval_canFinish__1 .* --max-samples 32 --max-steps 40\b/);
    assert.equal(allowed.broken, true);
    const trace = allowed.traces[0];
    assert.deepEqual(trace?.at(-1)?.evaluated, { name: "canFinish", picks: {}, result: true });
    replay(await import(path.join(lateGuard, "gen/gate.ts")), trace, guardModel);
    assert.match(allowed.again, /gen\/gate\.guard\.run\.qnt/);
  });

  test("shallow and deep goals each supply a journey and receive their independent search", async () => {
    const root = oneRule("route", "Take one step and then continue", `pure val initial: int = 0
pure def advance(n: int): int = n + 1
pure def sometimesStarted(n: int): bool = n > 0
pure def sometimesLate(n: int): bool = n == 38`);
    const spec = readSpecs(root)[0];
    const model = await gen(root, spec);
    const domain = await import(pathToFileURL(path.join(root, "gen", "route.ts")).href);
    const { said, tested } = await simulation({ root, fresh: true, used: new Set() }, spec, [spec], model, domain, 1);
    assert.ok(said.every((r) => r.ok), JSON.stringify(said));
    assert.deepEqual(tested?.journeys.map(({ events }) => events.length), [1, 38]);
    const actions = fs.readdirSync(path.join(root, "gen", "traces"));
    assert.ok(actions.some((name) => name.startsWith("route.never_sometimesLate.")));
    assert.ok(actions.some((name) => name.startsWith("route.never_sometimesStarted.")));
  });

  test("simulation and probes preserve guarded transitions and outputs when only the state enables an event", async () => {
    const root = oneRule("counter", "Open and commit", `type Change = { state: int, out: List[str] }
pure val initial: int = 0
pure def canOpen(n: int): bool = n == 0
pure def open(n: int, label: bool): Change = { state: 1, out: List(if (label) "yes" else "no") }
pure def canCommit(n: int, approved: bool): bool = n == 1 and approved
pure def commit(n: int, approved: bool): Change = if (approved) { state: 2, out: List("saved") } else { state: 3, out: List("wrong") }
pure def alwaysValid(n: int): bool = n <= 2`);
    const spec = readSpecs(root)[0];
    const model = await gen(root, spec);
    const domain = await import(pathToFileURL(path.join(root, "gen", "counter.ts")).href);
    const harness = { memory: { root, fresh: true, used: new Set<string>() }, model, files: harnessFiles(spec, [spec], model) };
    const [safety, probe] = await Promise.all(["step", "probe"].map((step) => simulate(harness, "inv", 64, 64, step)));
    assert.equal(safety.broken, false);
    assert.equal(probe.broken, false);
    for (const trace of [...safety.traces, ...probe.traces]) replay(domain, trace, model);
    const emitted = safety.traces.flat().flatMap((step) => step.out ?? []);
    assert.deepEqual(new Set(emitted), new Set(["yes", "no", "saved"]));
    const commits = probe.traces.flat().flatMap(({ evaluated }) => evaluated?.name === "commit" ? [{ picks: evaluated.picks, result: evaluated.result }] : []);
    assert.ok(commits.length > 0);
    assert.ok(commits.every(({ picks, result }) => picks.approved === true && JSON.stringify(result) === '{"state":2,"out":["saved"]}'));
  });

  test("adding a witness keeps ordinary simulation, proof and runtime generation stable", async () => {
    const source = [
      "type State = { count: int }",
      "pure val initial: State = { count: offset(1) }",
      "pure val other = 7",
      "pure def offset(n: int): int = { val other = n; other + base }",
      "pure def canAdvance(s: State, amount: int): bool = amount > s.count",
      "pure def advance(s: State, amount: int): State = { count: amount }",
      "pure def retreat(s: State): State = { count: s.count - 1 }",
      "pure def alwaysCounts(s: State): bool = s.count >= 0",
      "pure val base = 2",
    ];
    const emit = async (lines: string[]) => {
      const root = oneRule("counter", "Count", lines.join("\n"));
      const m = await gen(root, readSpecs(root)[0]);
      const runtime = await import(pathToFileURL(path.join(root, "gen", "counter.ts")).href);
      assert.deepEqual([runtime.initial, runtime.other], [{ count: 3 }, 7]);
      return [m.harness, m.guardHarness, m.ts, m.render("proof_", false), m.exports.types, m.exports.values];
    };
    const steps = Array.from({ length: 10 }, (_, i) => `("advance", other + ${i})`);
    const guide = `pure val eval_witness_canAdvance = (${steps.join(", ")})`;
    const [ordinary, guided] = await Promise.all([emit(source), emit([source[0], guide, ...source.slice(1)])]);
    assert.deepEqual(guided, ordinary);
  });

  test("a concrete witness uses the original guards and rules and supplies its steps to replay", async () => {
    const modelSource = `pure val initial: int = 0
pure def publish(n: int, amount: int): int = amount
pure def canPublish(n: int, amount: int): bool = n == 0 and amount > 0
pure def finish(n: int): int = n + 1
pure def canFinish(n: int): bool = n > 0 and n < 42
pure def alwaysSafe(n: int): bool = n <= 42
pure def sometimesDone(n: int): bool = n == 42
pure val witnessIndex = 3
pure val witnessSender = 4
pure val witness_fixture = 5
pure val witness_sometimesDone = 6
pure def witnessStep_sometimesDone(n: int): int = n`;
    const example = (source: string, guide: string) => `${source}\npure val eval_witness_sometimesDone = ${guide}`;
    const fixture = (source: string, guide: string) => oneRule("journey", "Publish then finish", example(source, guide));
    const runExample = async (root: string) => {
      const spec = readSpecs(root)[0];
      const model = await gen(root, spec);
      const domain = await import(pathToFileURL(path.join(root, "gen", "journey.ts")).href);
      assert.deepEqual([domain.witnessIndex, domain.witnessSender, domain.witness_fixture, domain.witness_sometimesDone, domain.witnessStep_sometimesDone(7)], [3, 4, 5, 6, 7]);
      return simulation({ root, fresh: false, used: new Set() }, spec, [spec], model, domain, 1);
    };
    const original = fixture(modelSource, '(("publish", 41), "finish")');
    const ordinary = fixture(`${modelSource}\npure val amountValues = Set(43)`, '(("publish", 41), "finish")');
    const simulateExample = (source: string, guide: string) => runExample(fixture(source, guide));
    const [reached, denied, unsafe, mistyped, ordinaryFailure] = await Promise.all([
      runExample(original),
      simulateExample(modelSource.replace("n == 42", "n == 1"), '("publish", -1)'),
      simulateExample(modelSource, '(("publish", 43), "finish")'),
      simulateExample(modelSource, '("publish", "unknown")'),
      runExample(ordinary),
    ]);
    assert.ok(reached.said.some((r) => r.ok && r.summary === "sometimesDone is reachable"), JSON.stringify(reached.said));
    assert.ok(reached.said.some((r) => r.ok && r.stage === "replay"), JSON.stringify(reached.said));
    assert.deepEqual(reached.tested?.journeys[0]?.events, [{ type: "publish", amount: 41 }, { type: "finish" }]);
    assert.ok(denied.said.some((r) => r.ok && r.summary === "sometimesDone is reachable"), JSON.stringify(denied.said));
    assert.ok(unsafe.said.some((r) => !r.ok && r.stage === "always" && r.detail.includes('publish{"amount":43}')), JSON.stringify(unsafe.said));
    assert.ok(mistyped.said.some((r) => !r.ok && /Couldn't unify (?:int and str|str and int)/.test(r.detail)), JSON.stringify(mistyped.said));
    fs.writeFileSync(path.join(original, "spec/journey.md"), ruleSpec(example(modelSource, '(("publish", 42), "finish")'), "Publish then finish"));
    const edited = await runExample(original);
    assert.deepEqual(edited.tested?.journeys[0]?.events, [{ type: "publish", amount: 42 }]);
    const reproduction = "gen/traces/journey.ordinary/journey.run.qnt";
    const again = ordinaryFailure.said.find((row) => !row.ok && row.detail.includes(`quint run ${reproduction}`));
    assert.ok(again, JSON.stringify(ordinaryFailure.said));
    const recovered = await runExample(ordinary);
    assert.deepEqual(recovered.said, ordinaryFailure.said);
    const [command] = again.detail.split("\n").filter((line) => line.includes(`quint run ${reproduction}`));
    const rerun = await tool("quint", command.slice(command.indexOf("quint run ") + "quint ".length).split(" "), ordinary);
    assert.ok(violated(rerun), rerun.out);

    const guardedPath = (first: string, target = "canFinish") => oneRule("gate", "Allow a reachable transition", [
      "pure val initial: int = 0",
      "pure def up(n: int, amount: int): int = n + amount",
      "pure val amountValues = Set(1)",
      "pure def canMark(n: int): bool = n >= 38",
      "pure def mark(n: int): int = n + 1",
      "pure def canFinish(n: int): bool = n >= 39",
      "pure def finish(n: int): int = 0",
      "pure def alwaysSafe(n: int): bool = n <= 500",
      `pure val eval_witness_${target} = (("up", ${first}), "mark", "finish")`,
    ].join("\n"));
    const guidedGuard = async (root: string) => {
      const spec = readSpecs(root)[0], model = await gen(root, spec);
      const domain = await import(pathToFileURL(path.join(root, "gen/gate.ts")).href);
      return simulation({ root, fresh: false, used: new Set() }, spec, [spec], model, domain, 1);
    };
    const direct = guardedPath("38"), stopped = guardedPath("1");
    const [complete, fallback, bad] = await Promise.all([guidedGuard(direct), guidedGuard(stopped), guidedGuard(guardedPath("501"))]);
    for (const result of [complete, fallback]) {
      assert.ok(result.said.some((r) => r.ok && r.summary.includes("2 of 2 guards allow")), JSON.stringify(result.said));
      assert.ok(result.said.some((r) => r.ok && r.stage === "replay"));
    }
    for (const event of [{ type: "up", amount: 38 }, { type: "mark" }, { type: "finish" }])
      assert.ok(complete.tested?.events.some((actual) => isDeepStrictEqual(actual, event)), JSON.stringify(complete.tested?.events));
    const positiveFile = (name: string) => `gen/traces/gate.never_allows_${name}.eval_${name}__1/0.itf.json`;
    for (const guard of ["canMark", "canFinish"]) {
      assert.ok(!fs.existsSync(path.join(direct, positiveFile(guard))));
      assert.ok(fs.existsSync(path.join(stopped, positiveFile(guard))));
    }
    assert.ok(bad.said.some((r) => !r.ok && r.stage === "always" && r.detail.includes('up{"amount":501}')), JSON.stringify(bad.said));
    for (const [root, error] of [
      [guardedPath("38", "canMark"), /last transition must be guarded by canMark/],
      [guardedPath("38", "canMissing"), /name a declared .*transition guard/],
    ] as const) await assert.rejects(gen(root, readSpecs(root)[0]), error);

    const refusalSource = `type Clock = { elapsed: int }
pure val initial: Clock = { elapsed: 0 }
pure def canTick(c: Clock, amount: int): bool = amount >= 0
pure def tick(c: Clock, amount: int): Clock = { elapsed: c.elapsed + amount }
pure def alwaysNonnegative(c: Clock): bool = c.elapsed >= 0
pure val amountValues = Set(0, 1)`;
    const clock = (guide = "") => oneRule("clock", "A tick never goes backward", refusalSource + guide);
    const refusing = clock("\npure val eval_refuse_canTick = { amount: -1 }");
    const allowed = clock("\npure val eval_refuse_canTick = { amount: 0 }");
    const checkClock = async (root: string) => {
      const spec = readSpecs(root)[0];
      const model = await gen(root, spec);
      const domain = await import(pathToFileURL(path.join(root, "gen", "clock.ts")).href);
      const check = await simulation({ root, fresh: false, used: new Set() }, spec, [spec], model, domain, 1);
      return { model, check };
    };
    const [before, after, miss] = await Promise.all([checkClock(clock()), checkClock(refusing), checkClock(allowed)]);
    assert.ok(before.check.said.some((r) => r.summary.includes("never seen to refuse") && r.summary.includes("canTick")));
    assert.ok(after.check.said.some((r) => r.ok && r.summary.endsWith("and refuse it in another")));
    assert.ok(after.check.said.some((r) => r.ok && r.stage === "replay"));
    assert.deepEqual(miss.check, before.check);
    assert.deepEqual(after.check.tested, before.check.tested);
    assert.deepEqual(
      [after.model.ts, after.model.harness, after.model.guardHarness],
      [before.model.ts, before.model.harness, before.model.guardHarness],
    );
    const candidateRun = "gen/traces/clock.never_refuses_canTick.eval_canTick__2/0.itf.json";
    const randomProbe = "gen/traces/clock.never_refuses_canTick.probe/0.itf.json";
    const last = JSON.parse(read(candidateRun, refusing)).states.at(-1);
    assert.deepEqual(last.outcome, { tag: "Out_canTick", value: false });
    assert.deepEqual(last["mbt::nondetPicks"].amount.value, { "#bigint": "-1" });
    assert.ok(fs.existsSync(path.join(allowed, candidateRun)));
    assert.ok(fs.existsSync(path.join(allowed, randomProbe)));
    assert.ok(!fs.existsSync(path.join(refusing, randomProbe)));
    for (const [guide, error] of [
      ["eval_refuse_canMissing = { amount: -1 }", /name a transition guard/],
      ["eval_refuse_canTick = { elapsed: -1 }", /needs the argument amount/],
      ['eval_refuse_canTick = { amount: "no" }', /does not have the type expected/],
    ] as const) {
      const root = clock(`\npure val ${guide}`);
      await assert.rejects(gen(root, readSpecs(root)[0]), error);
    }
  });

  test("hand-written code that changes what it is checked against is refused or flagged", async () => {
    const { said, text } = await run(copyOfProject("src/ledger.ts", (s) => s.replace(/(\/\/@ ensures)/, "//@ requires true\n$1")));
    assert.ok(said("proof", /^src-ledger\.ts: .*under 2 \/\/@ requires/), text);
  });

  test("the application's types and tests are checked, in VibeLang and in the TypeScript beside it, on a Node that loads both; test/ that nothing runs gets Vitest, as `spec init` sets it up", async () => {
    const never = (wrong: object) => installed(fixtures(["door"], (f) => Object.assign(f, wrong, {
      "test/never.test.vibe": citing("spec/door.md", "Story: Use the door") + 'import { assert, it } from "@effect/vitest"\nit("never holds", () => { assert.strictEqual(1, 2) })\n',
    })));
    const failingRoot = copyOfProject("test/app.test.vibe", (s) => s + "\n" + citing("spec/index.md", "Story: Check out") + 'it("never holds", () => { assert.strictEqual(1, 2) })\n');
    const manifest = JSON.parse(read("package.json", failingRoot));
    manifest.scripts.test = `node --input-type=module -e "delete process.env.NO_COLOR; process.env.FORCE_COLOR='1'; process.argv=[process.argv[0],'vitest','run']; await import(new URL('vitest.mjs',import.meta.resolve('vitest/package.json')));"`;
    fs.writeFileSync(path.join(failingRoot, "package.json"), JSON.stringify(manifest));
    const plainRoot = never({});
    const [mistyped, failing, plain, both] = await Promise.all([
      run(copyOfProject("src/app.vibe", (s) => s + "\nconst wrong: number = \"x\"\n")),
      run(failingRoot),
      run(plainRoot),
      run(never({ "src/wrong.ts": 'export const wrong: number = "x";\n' })),
    ]);
    const unfit = "application does not fit the generated contract";
    assert.equal(mistyped.said("types", /./)?.summary, unfit, mistyped.text);
    assert.match(stripVTControlCharacters(mistyped.text), /src\/app\.vibe(?:\(\d+,\d+\):|:\d+:\d+ -) error TS2322/);
    assert.deepEqual(failing.failed, ["tests"], failing.text);
    // Colored runner output still starts at the failure list and names the failed assertion.
    assert.ok(failing.said("tests", /^fail\n +⎯+ Failed Tests 1 ⎯+\n[\s\S]*test\/app\.test\.vibe > never holds[\s\S]*expected 1 to equal 2/), failing.text);
    assert.deepEqual(plain.failed, ["tests", "review"], plain.text);
    assert.ok(plain.said("tests", /^test\/ had nothing to run it: added "test": "vitest run" to package\.json, and vitest\.config\.ts, as `spec init` does\n$/), plain.text);
    assert.ok(plain.said("tests", /^fail\n[\s\S]*never holds/), plain.text);
    const initialized = scratch({});
    init(initialized, () => {});
    assert.deepEqual([JSON.parse(read("package.json", plainRoot)).scripts, read("vitest.config.ts", plainRoot)], [{ test: "vitest run" }, read("vitest.config.ts", initialized)]);
    // Tests and traces are not run on code that does not fit the contract (SPEC.md, "Stages of `pnpm check`").
    assert.deepEqual(both.failed, ["types", "review"], both.text);
    assert.equal(both.said("types", /./)?.summary, unfit, both.text);
    assert.match(stripVTControlCharacters(both.text), /src\/wrong\.ts(?:\(1,14\):|:1:14 -) error TS2322/);
    assert.ok(both.said("skipped", /^tests, traces and explore: a stage above failed/), both.text);
    const untyped = copyOfProject();
    fs.rmSync(path.join(untyped, "tsconfig.json"));
    assert.ok((await run(untyped)).failed.includes("types"));
    // One Node floor: what the command refuses below and `init` writes is the major release .nvmrc pins and the root's `engines` names.
    assert.deepEqual([read(".nvmrc").trim().split(".")[0], JSON.parse(read("package.json")).engines.node], [String(NODE), `>=${NODE}`]);
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

  test("a test pass is remembered for what the tests read and a typecheck's for what the compiler read; runner receipts allow reuse but a forged Turbo environment does not; unchecked specs are noted", async () => {
    const ran = path.join(scratch({}), "ran");
    const root = fixtures(["door"], (f) => Object.assign(f, {
      "package.json": JSON.stringify({ scripts: { test: `node -e "require('node:fs').readFileSync('fixtures/reviewed.proof.dfy')" && echo x >> ${JSON.stringify(ran)}` } }),
      "fixtures/reviewed.proof.dfy": "lemma Reviewed() ensures true {}\n",
      "src/door.ts": 'import { one } from "../.shared/one.ts";\nexport const door: number = one;\n',
      ".shared/one.ts": "export const one = 1;\n",
    }));
    const runs = () => fs.readFileSync(ran, "utf8").length / 2;
    const typed = () => fs.readdirSync(path.join(root, ".spec-cache")).filter((f) => f.startsWith("types-")).map((f) => `${f} ${fs.statSync(path.join(root, ".spec-cache", f)).ino}`);
    const first = await run(root);
    assert.ok(first.said("tests", /^pass\n$/) && first.said("tests", /^note: no test or driver checks spec\/door\.md;/), first.text);
    const compiled = typed();
    await run(root);
    assert.equal(runs(), 1);
    fs.appendFileSync(path.join(root, "spec/door.md"), "\nProse that no compiler reads.\n");
    await run(root);
    assert.deepEqual([runs(), typed()], [1, compiled], "neither the tests nor the compiler read the prose: they read the generated modules");
    fs.writeFileSync(path.join(root, ".shared/one.ts"), 'export const one = "1";\n');
    const mistyped = await run(root);
    assert.equal(mistyped.said("types", /./)?.ok, false, `a file the compiler read changed, outside what the package's inputs cover\n${mistyped.text}`);
    fs.writeFileSync(path.join(root, "src/door.ts"), "export const door = 2;\n");
    await run(root);
    assert.equal(runs(), 2);
    fs.mkdirSync(path.join(root, "test"));
    fs.writeFileSync(path.join(root, "test/door.test.ts"), 'import { test } from "node:test";\nimport { door } from "../src/door.ts";\ntest("uncited", () => { void door; });\n');
    const turbo = await exec(process.execPath, [path.join(project, "vibestack/spec.ts"), "check", "--json"], root, { ...process.env, TURBO_HASH: "1", npm_lifecycle_event: "check" });
    const said = answer(turbo.stdout).results.filter((r: Result) => r.stage === "tests").map((r: Result) => [r.ok, r.summary]);
    assert.deepEqual(said, [[false, "1 tests cite no story or rule: cite the one each serves, fold it into the journey that does, or propose deleting it"],
      [true, "note: no test or driver checks spec/door.md; a story that leaves the verified core needs a journey that cites it"], [true, "pass"]]);
    assert.equal(runs(), 3, "a Turbo environment value cannot claim that the test script ran");
    const receipt = testReceipt(root);
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.writeFileSync(receipt, JSON.stringify({ fingerprint: testInputs(root) }));
    const reused = await run(root);
    assert.ok(reused.said("tests", /^pass: the test runner recorded success for these inputs\n$/), reused.text);
    assert.equal(reused.said("tests", /^1 tests cite no story or rule/)?.ok, false, reused.text);
    assert.equal(runs(), 3);
    fs.writeFileSync(path.join(root, "src/door.ts"), "export const door = 3;\n");
    await run(root);
    assert.equal(runs(), 4, "a receipt for older source cannot suppress the tests");
    fs.rmSync(path.join(root, "fixtures/reviewed.proof.dfy"));
    const missingFixture = await run(root);
    assert.equal(missingFixture.said("tests", /^fail\n/)?.ok, false, missingFixture.text);
    const linked = scratch({ "package.json": '{"name":"linked","type":"module","main":"./dist/run.js"}', "dist/run.js": "export default true;" });
    const consumer = fixtures(["door"]);
    fs.mkdirSync(path.join(consumer, "node_modules"));
    fs.symlinkSync(linked, path.join(consumer, "node_modules", "linked"), "dir");
    fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ dependencies: { linked: `link:${path.relative(consumer, linked)}` },
      scripts: { test: `node --input-type=module -e "import ok from 'linked'; process.exit(ok ? 0 : 1)"` } }));
    assert.ok((await run(consumer)).said("tests", /^pass\n$/));
    fs.writeFileSync(path.join(linked, "dist/run.js"), "export default false;");
    assert.equal((await run(consumer)).said("tests", /^fail/)?.ok, false, "a passing run cannot mask a change in a linked package's built code");
    const workspace = scratch({ "tsconfig.json": "{}", "package.json": JSON.stringify({ devDependencies: { kit: "workspace:*" } }),
      ...Object.fromEntries(["src/a.ts", "test/a.test.ts", "test/drivers/a.ts", "test/traces/a.jsonl", "test/counterexamples/a.json", "test/bombadil.ts", "test/fixtures/p/package.json",
        "test/fixtures/p/a.ts", "apps/other/package.json", "apps/other/a.ts", "kit/package.json", "kit/a.ts", "kit/spec/a.md", "kit/nested/package.json", "kit/nested/a.ts", "kit/README.md", "kit/fixtures/a.md", "kit/test/a.test.ts", "kit/gen/a.ts", "notes.md", "README.md", "AGENTS.md", "style.css", "gen/a.qnt", "gen/traces/a.b.0/0.itf.json",
        "generated/stories/.cache/manifest.json", "spec/a.md", "spec/lock.json", "spec/a.proof.dfy", "src/a.proof.dfy"].map((f) => [f, "{}"])) });
    fs.mkdirSync(path.join(workspace, "node_modules"));
    fs.symlinkSync("../kit", path.join(workspace, "node_modules/kit"), "dir");
    const inputs = () => (["tests", "types"] as const).map((read) => testInputs(workspace, "normal", read));
    const changed = (file: string) => {
      const before = inputs();
      fs.appendFileSync(path.join(workspace, file), " ");
      return inputs().map((after, i) => after !== before[i]);
    };
    assert.deepEqual(Object.fromEntries(["src/a.ts", "test/a.test.ts", "test/drivers/a.ts", "test/traces/a.jsonl", "test/counterexamples/a.json", "test/bombadil.ts",
      "test/fixtures/p/a.ts", "apps/other/a.ts", "kit/a.ts", "kit/package.json", "kit/spec/a.md", "kit/nested/a.ts", "kit/README.md", "kit/fixtures/a.md", "kit/test/a.test.ts", "kit/gen/a.ts",
      ".DS_Store", "notes.md", "README.md", "AGENTS.md", "style.css", "gen/a.qnt", "gen/traces/a.b.0/0.itf.json", "generated/stories/.cache/manifest.json", "spec/a.md", "spec/lock.json", "spec/a.proof.dfy", "src/a.proof.dfy"].map((f) => [f, changed(f)])), {
      "src/a.ts": [true, true], "test/a.test.ts": [true, true], "test/drivers/a.ts": [true, true], "test/traces/a.jsonl": [true, false],
      "test/counterexamples/a.json": [true, false], "test/bombadil.ts": [true, true], "test/fixtures/p/a.ts": [true, true], "apps/other/a.ts": [false, false],
      "kit/a.ts": [true, true], "kit/package.json": [true, true], "kit/spec/a.md": [false, false], "kit/nested/a.ts": [false, false],
      "kit/README.md": [false, false], "kit/fixtures/a.md": [true, false], "kit/test/a.test.ts": [false, false], "kit/gen/a.ts": [false, false], ".DS_Store": [false, false],
      "notes.md": [true, false], "README.md": [false, false], "AGENTS.md": [false, false], "style.css": [true, false], "gen/a.qnt": [false, false],
      "gen/traces/a.b.0/0.itf.json": [false, false], "generated/stories/.cache/manifest.json": [false, false], "spec/a.md": [false, false], "spec/lock.json": [true, false],
      "spec/a.proof.dfy": [true, false], "src/a.proof.dfy": [true, false],
    }, "the tests read the package, its test fixtures, what its workspace dependencies ship to it and the fixtures they keep; the typecheck reads only scripts and JSON, and no traces or counterexamples; neither reads a spec's prose or its Quint copy, the prose kept for people and agents, the simulations' traces or the stories' bookkeeping");
    fs.writeFileSync(path.join(workspace, "kit/a.ts"), 'export * from "./gen/a.ts";\n');
    assert.deepEqual(changed("kit/gen/a.ts"), [true, true], "a dependency's gen/ is read once its code imports it");
    fs.writeFileSync(path.join(workspace, "kit/package.json"), '{"dependencies":{"linked":"link:../runtime"}}');
    for (const group of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ [group]: { kit: "workspace:*" } }));
      assert.deepEqual(inputs(), [undefined, undefined], `a link reached through ${group} can change independently of the lockfile`);
    }
  });

  test("an exploration is remembered under what its page reads: its code and what that names, what a workspace package it imports or runs offers, the generated modules it imports, and no test, contract, proof, spec or tool it does not run", () => {
    const workspace = scratch({
      "app/package.json": JSON.stringify({ scripts: { dev: "vite", serve: "served-cli", copy: "cp ../shared/copied.txt ." }, dependencies: { kit: "workspace:*", served: "workspace:*" }, devDependencies: { unused: "workspace:*" } }),
      "app/index.html": '<script type="module" src="/src/main.ts"></script>\n',
      "app/src/main.ts": 'import { b } from "kit";\nimport "../../shared/b.ts";\nimport { a } from "../gen/a.ts";\nexport const page = a + b;\n',
      "app/gen/b.ts": "export const b = 1;\n", "aliased/package.json": "{}\n", "aliased/src/main.ts": 'import { a } from "@gen/a.ts";\nexport const page = a;\n', "aliased/gen/a.ts": "export const a = 1;\n",
      "app/src/main.css": '@source "../../kit/scanned";\n',
      "app/src/a.contract.ts": 'import "unused";\n', "app/src/a.proof.dfy": "lemma A() {}\n", "app/spec/a.md": "# A\n", "app/test/a.test.ts": 'import "unused";\n',
      "app/vitest.config.ts": 'import "unused";\n', "app/test/bombadil.ts": "export {};\n", "app/gen/a.ts": "export const a = 1;\n", "app/gen/a.qnt": "module a {}\n",
      "kit/package.json": JSON.stringify({ exports: { ".": "./src/index.ts", "./items/*": { browser: "./parts/item-*.js", default: "./build/items/*.js" } } }),
      "kit/src/index.ts": 'export * from "./b.ts";\n', "kit/src/b.ts": "export const b = 1;\n",
      "kit/parts/item-one.js": "export default 1;\n", "kit/parts/item-/nested.txt": "\n",
      "kit/src/c.ts": "export const c = 1;\n", "kit/README.md": "# Kit\n", "kit/scanned/x.ts": 'import "unused";\n',
      "served/package.json": JSON.stringify({ bin: { "served-cli": "./cli.js" } }), "served/cli.js": "\n",
      "unused/package.json": JSON.stringify({ exports: "./index.ts" }), "unused/index.ts": "\n",
      "shared/b.ts": "export const b = 1;\n", "shared/c.ts": "export const c = 1;\n", "shared/copied.txt": "\n",
    });
    fs.mkdirSync(path.join(workspace, "app/node_modules"));
    for (const dependency of ["kit", "served", "unused"]) fs.symlinkSync(`../../${dependency}`, path.join(workspace, "app/node_modules", dependency), "dir");
    const page = path.join(workspace, "app");
    const changed = (file: string, edit = (text: string) => `${text} `) => {
      const before = pageInputs(page);
      fs.writeFileSync(path.join(workspace, file), edit(fs.readFileSync(path.join(workspace, file), "utf8")));
      return pageInputs(page) !== before;
    };
    assert.deepEqual({
      ...Object.fromEntries(["app/src/main.ts", "app/src/main.css", "app/src/a.contract.ts", "app/src/a.proof.dfy", "app/spec/a.md", "app/test/a.test.ts", "app/vitest.config.ts",
        "app/test/bombadil.ts", "app/gen/a.qnt", "kit/src/b.ts", "kit/src/c.ts", "kit/README.md", "kit/scanned/x.ts", "served/cli.js", "unused/index.ts",
        "shared/b.ts", "shared/c.ts", "shared/copied.txt"].map((f) => [f, changed(f)])),
      "kit/parts/item-one.js": changed("kit/parts/item-one.js"),
      "kit/package.json": changed("kit/package.json", (text) => text.replace('"./items/*"', '"./renamed/*"')),
      "app/gen/a.ts": changed("app/gen/a.ts"), "app/gen/b.ts": changed("app/gen/b.ts"),
      "aliased/gen/a.ts": (() => { const before = pageInputs(path.join(workspace, "aliased")); fs.appendFileSync(path.join(workspace, "aliased/gen/a.ts"), " "); return pageInputs(path.join(workspace, "aliased")) !== before; })(),
    }, {
      "app/src/main.ts": true, "app/src/main.css": true, "app/src/a.contract.ts": false, "app/src/a.proof.dfy": false, "app/spec/a.md": false, "app/test/a.test.ts": false,
      "app/vitest.config.ts": false, "app/test/bombadil.ts": true, "app/gen/a.qnt": false, "kit/src/b.ts": true, "kit/src/c.ts": false, "kit/README.md": false,
      "kit/scanned/x.ts": true, "served/cli.js": true, "unused/index.ts": false, "shared/b.ts": true, "shared/c.ts": false, "shared/copied.txt": true,
      "kit/parts/item-one.js": true, "kit/package.json": true,
      "app/gen/a.ts": true, "app/gen/b.ts": false, "aliased/gen/a.ts": true,
    }, "the page reads its code, the files and directories it names, what the packages it imports or runs export, and the generated modules it imports, or all of them where it names none; not what only its checks read, nor what a file it only scans imports");
    const enclosing = scratch({
      "package.json": '{"main":"./entry.js"}', "entry.js": 'export default "first";',
      "app/package.json": "{}", "app/src/main.ts": 'import value from "../../";',
      "app/vite.config.ts": 'export default { base: "./" };', "unrelated.txt": "outside the page",
    });
    const inner = path.join(enclosing, "app"), source = path.join(inner, "src/main.ts");
    assert.equal(pageInputs(inner), undefined, "a relative import may read the enclosing package entry");
    fs.writeFileSync(source, 'export const dir = new URL("../../", import.meta.url);');
    assert.equal(pageInputs(inner), undefined, "a directory URL may be consumed dynamically");
    fs.writeFileSync(source, 'import path from "node:path"; const dir = import.meta.dirname; export const parent = path.resolve(dir, "../../..");');
    assert.equal(pageInputs(inner), undefined, "a computed path may alias the source directory");
    fs.writeFileSync(source, 'export const valid = (part: string) => ![part].includes("..");');
    const bounded = pageInputs(inner);
    assert.ok(bounded, "a public Vite base does not read the directory");
    fs.appendFileSync(path.join(enclosing, "unrelated.txt"), " unrelated edit");
    assert.equal(pageInputs(inner), bounded);
    fs.writeFileSync(path.join(inner, "vite.config.ts"), 'const data = { base: "./" }; export default { plugins: [readDirectory(data.base)] };');
    assert.equal(pageInputs(inner), undefined, "a plugin can read a directory stored in its own base property");
    fs.writeFileSync(path.join(inner, "vite.config.ts"), 'const defineConfig = (args) => readDirectory(args.base); export default defineConfig({ base: "./" });');
    assert.equal(pageInputs(inner), undefined, "a user function can consume its base as a directory");
    fs.writeFileSync(path.join(inner, "vite.config.ts"), 'import { defineConfig as config } from "vite"; export default config({ base: "./" });');
    assert.ok(pageInputs(inner), "Vite's own config helper accepts a URL base through an alias");
    fs.writeFileSync(path.join(inner, "vite.config.ts"), 'export default { base: "./" };');
    fs.symlinkSync(enclosing, path.join(inner, "outer"), "dir");
    fs.writeFileSync(path.join(inner, "src/main.css"), '@source "../outer";');
    assert.equal(pageInputs(inner), undefined, "a symlinked Tailwind source is judged by its physical directory");
    fs.writeFileSync(path.join(inner, "src/main.css"), '@source "../outer/**/*.html";');
    assert.equal(pageInputs(inner), undefined, "an explicit Tailwind glob cannot be treated as a missing file");
    fs.unlinkSync(path.join(inner, "outer"));
    fs.mkdirSync(path.join(enclosing, "bounded"));
    fs.symlinkSync(path.join(enclosing, "bounded"), path.join(inner, "outer"), "dir");
    const retargeted = pageInputs(inner);
    assert.ok(retargeted);
    fs.writeFileSync(path.join(enclosing, "bounded/class.html"), '<p class="underline">');
    assert.notEqual(pageInputs(inner), retargeted);
    const beforeBuild = pageInputs(page);
    const build = path.join(workspace, "kit/build");
    fs.mkdirSync(build);
    fs.writeFileSync(path.join(build, "sibling.js"), "export default 0;\n");
    assert.equal(pageInputs(page), beforeBuild, "a sibling of an absent wildcard directory is outside the offered tree");
    const items = path.join(build, "items");
    fs.mkdirSync(items);
    const built = path.join(items, "one.js");
    fs.writeFileSync(built, "export default 2;\n");
    assert.notEqual(pageInputs(page), beforeBuild, "an export appearing under a previously absent directory invalidates the exploration");
    fs.unlinkSync(built);
    assert.equal(pageInputs(page), beforeBuild);
    fs.rmdirSync(items);
    fs.symlinkSync("items", items, "dir");
    assert.throws(() => pageInputs(page), { code: "ELOOP" });
  });

  test("a rule whose prose or model changed names the code that cites it, for a person to read again", () => {
    const root = copyOfProject("spec/index.md", (s) => s.replace("### No more can be removed than the order holds\n", "$&\nNot one more.\n"));
    const shown = pending(root, readSpecs(root)[0]).filter((p) => p.cited).map(showPending);
    const line = read("spec/index.md", root).split("\n").indexOf("### No more can be removed than the order holds") + 1;
    assert.deepEqual(shown, [`spec/index.md:${line}  Story: Change my mind / No more can be removed than the order holds\n      prose changed: update the model to match, or confirm it already does\n      cited by test/app.test.vibe:19: read them again against it`]);
    fs.writeFileSync(path.join(root, "test/app.test.vibe"), "\n" + read("test/app.test.vibe", root));
    assert.deepEqual(pending(root, readSpecs(root)[0]).flatMap((p) => p.cited ?? []), ["test/app.test.vibe:20"]);
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
    const probed = ["mailer", "shop", "vault"];
    assert.deepEqual(await genAll(root), ["_conformance.ts", "package.json", ...names.flatMap((n) => [`${n}.qnt`, `${n}.run.qnt`, `${n}.ts`, `${n}.effect.vibe`, ...(n === "lib" ? [] : [`${n}.conformance.ts`]), ...(probed.includes(n) ? [`${n}.guard.run.qnt`] : [])])].sort());
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

  test("an imported constant keeps the types declared under its own nested aliases in proofs", async () => {
    const product = 'import staging as St from "./staging"\npure val launcherName: str = St::noCall.descriptor.name\n'
      + 'pure def lawNamesLauncher(name: str): bool = (name != "empty") implies launcherName != name';
    const root = scratch({
      "spec/runtime.md": ruleSpec("type Abi = Arm64 | X86_64", "Runtime", "Runtime"),
      "spec/staging.md": ruleSpec('import runtime as R from "./runtime"\ntype NativeRequest = NoNative | NativeFor({ abi: R::Abi })\n'
        + 'type Launcher = { native: NativeRequest, name: str }\ntype Call = { descriptor: Launcher }\n'
        + 'pure val noCall: Call = { descriptor: { native: NativeFor({ abi: R::Arm64 }), name: "empty" } }', "Staging", "Staging"),
      "spec/product.md": ruleSpec(product, "Product", "Product"),
      "spec/host.md": ruleSpec("type Abi = Linux | Mac", "Host", "Host"),
      "spec/productWithHost.md": ruleSpec('import host as R from "./host"\n' + product
        + "\npure val hostAbi: R::Abi = R::Linux", "Product with host", "Product with host"),
    });
    const { failed, said, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
    assert.ok(said("proof", /^product\.ts: all \d+ obligations proved/), text);
    assert.ok(said("proof", /^productWithHost\.ts: all \d+ obligations proved/), text);
  });

  test("local enums and records keep their Quint types in generated code and proof", async () => {
    const root = oneRule("choice", "Choose", "type Choice = Left | Right\ntype Pick = { side: Choice, n: int }\npure def read(p: Pick): int = if (p.side == Left) p.n else 0\npure def record(n: int, b: bool): int =\n  val p = { side: if (b) Left else Right, n: n }\n  read(p)\npure def updated(p: Pick): int =\n  val changed = p.with(\"side\", Left)\n  read(changed)\npure def choices(b: bool): List[Choice] = if (b) List(Left) else List(Right)\npure def use(c: Choice): int = if (c == Left) 1 else 2\npure def chosen(b: bool): int =\n  val c = if (b) Left else Right\n  use(c)\npure def lawChosen(b: bool): bool = chosen(b) == (if (b) 1 else 2)");
    const { failed, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
    const compiled = await tool("tsc", ["--ignoreConfig", "--noEmit", "--target", "es2023", "--module", "nodenext", "--strict", "--skipLibCheck", path.join(root, "gen/choice.ts")], project);
    assert.ok(compiled.ok, compiled.out);
    const choice = await import(path.join(root, "gen/choice.ts"));
    assert.deepEqual([choice.record(7, true), choice.record(7, false), choice.updated({ side: "Right", n: 9 }), choice.choices(true), choice.choices(false)], [7, 0, 9, ["Left"], ["Right"]]);
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
    const shop = (edit?: (files: Record<string, string>) => void) => shared(fixtures(["lib", "shop"], edit));
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
    assert.match(read("gen/proof/shop/shop.scaffold.dfy", plainRoot), /^lemma (\w+)_ensures\((\w+): Cart(?:, (\w+): \w+)*\)\n(?:  ensures .*\n)+\{\n  if inv\(\2\)(?: && \w+\(.*\))? \{\n    var after := \1\(\2.*\);\n  \}\n\}$/m, plain.text);
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

}

function eachCheckB() {
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
    const { failed, said, text } = await run(shared(fixtures(["account", "bank"], (f) => { f["spec/account.md"] = f["spec/account.md"].replace("type Account", "pure val amountValues = Set(7)\ntype Account"); })));
    assert.ok(failed.includes("sometimes"), text);
    assert.ok(said("sometimes", /\bsave in .* never happened/), text);
  });

  test("tables keyed by integers and variants, getOr, nthOr, removeAt, structural == and a mapped append are simulated, replayed, proved and typed, and a variant literal is typed for the prover wherever it stands", async () => {
    const root = fixtures(["hall"], (f) => { f["src/hall.ts"] = "export const hall = 1;\n"; });
    const { failed, said, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
    assert.ok(said("types", /./)?.ok, text);
    assert.ok(said("proof", /^hall\.ts: all \d+ obligations proved/), text);
    const compiled = await tool("tsc", ["--ignoreConfig", "--noEmit", "--target", "es2023", "--module", "nodenext", "--strict", "--skipLibCheck", path.join(root, "gen/hall.ts")], project);
    assert.ok(compiled.ok, compiled.out);
    const hall = await import(path.join(root, "gen/hall.ts"));
    // A seat equal to a booked one, though another object, is booked already.
    const booked = hall.step(hall.initial, { type: "book", row: 1, kind: "Adult" });
    assert.equal(hall.enabled(booked, { type: "book", row: 1, kind: "Adult" }), false);
    const parsed = hall.parseState(booked);
    assert.deepEqual(parsed, { booked: [{ row: 1, kind: "Adult" }], byRow: { 1: 1 }, byKind: { Adult: 1 } });
    parsed.byRow[1] = 2;
    parsed.byKind.Adult = 2;
    assert.deepEqual([booked.byRow, booked.byKind], [{ 1: 1 }, { Adult: 1 }]);
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
    // Every event of the order example is sent by someone; a trace carries the sender in the event.
    const trace = [{ state: domain.initial }, ...[{ type: "addItem", qty: 1 }, { type: "submit" }, { type: "pay", amount: 2 }]
      .map((event, i, all) => ({ event: { ...event, by: "Shopper" }, state: all.slice(0, i + 1).reduce((s, e) => domain.step(s, e, "Shopper"), domain.initial) }))];
    replay(domain, trace);
    const broken = { ...domain, step: (s: any, e: any, by: any) => (e.type === "pay" ? { ...domain.step(s, e, by), status: "Paid" } : domain.step(s, e, by)) };
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
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tsconfigured, "gen/proof/index/gen/tsconfig.json"), "utf8")).files, ["index.ts"]);
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
    const unofferedRoot = project((f) => { delete f["spec/highest.proof.dfy"]; });
    const bareRoot = project((f) => { delete f["spec/highest.proof.dfy"]; delete f["spec/ticket.proof.dfy"]; f["spec/typo.proof.dfy"] = ""; f["spec/notes.md"] = "# Notes\n"; f["spec/notes.proof.dfy"] = ""; });
    const [bare, proved, unoffered, trusting] = await Promise.all([
      run(bareRoot),
      run(root),
      run(unofferedRoot),
      run(project((f) => { f["spec/highest.proof.dfy"] = f["spec/highest.proof.dfy"].replace("ProofLib.FoldLeftMax", "assume false;\n  ProofLib.FoldLeftMax"); })),
    ]);
    // Without a proof file the law is not proved, and a proof file that belongs to nothing is pointed out. A spec that
    // defines nothing is no unit and starts no prover, so a proof file beside it has nothing to prove.
    assert.equal(bare.said("proof", /^highest\.ts: 1 of 1 obligations not proved/)?.ok, false, bare.text);
    assert.equal(bare.said("proof", /^spec\/typo\.proof\.dfy belongs to no proof unit/)?.ok, false, bare.text);
    assert.equal(bare.said("proof", /^spec\/notes\.proof\.dfy has nothing to prove: spec\/notes\.md defines no type or value/)?.ok, false, bare.text);
    assert.ok(!bare.said("proof", /^notes\.ts/) && !fs.existsSync(path.join(bareRoot, "gen/proof/notes")), bare.text);
    // With both proof files, everything proves, and the final Dafny is there to read.
    assert.deepEqual(proved.failed, ["review"], proved.text);
    assert.ok(proved.said("proof", /^ticket\.ts: all 3 obligations proved/), proved.text);
    assert.match(fs.readFileSync(path.join(root, "gen/proof/ticket/ticket.dfy"), "utf8"), /lemma \{:axiom\} highest_lawTheHighestIsAtLeastTheStart_ensures/);
    // A law its own unit does not prove is not offered.
    assert.equal(unoffered.said("proof", /^ticket\.ts: Dafny could not check it[\s\S]*unresolved identifier: highest_lawTheHighestIsAtLeastTheStart_ensures/)?.ok, false, unoffered.text);
    // That refusal is remembered: checked again, the unit runs neither LemmaScript nor Dafny, and says the same.
    const refusedAgain = await run(unofferedRoot);
    assert.equal(refusedAgain.said("proof", /^ticket\.ts: /)?.detail, unoffered.said("proof", /^ticket\.ts: /)?.detail, refusedAgain.text);
    assert.ok(!["gen", "check", "verify", "audit"].some((ran) => fs.existsSync(path.join(unofferedRoot, "gen/proof/ticket", ran))), refusedAgain.text);
    // Once the law is proved it is offered, and the importer is proved again.
    fs.copyFileSync(path.join(root, "spec/highest.proof.dfy"), path.join(unofferedRoot, "spec/highest.proof.dfy"));
    assert.ok((await run(unofferedRoot)).said("proof", /^ticket\.ts: all 3 obligations proved/));
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
    // Edited while what it imports is remembered, the importer is proved once, with only the clauses proved offered.
    const proofs = () => fs.readdirSync(path.join(mixedRoot, ".spec-cache")).filter((f) => f.startsWith("prove-"));
    const before = proofs();
    fs.appendFileSync(path.join(mixedRoot, "spec/consumer.proof.dfy"), "\n// Proved again.\n");
    const edited = await run(mixedRoot);
    assert.equal(edited.said("proof", /^consumer\.ts: 1 of 2 obligations not proved/)?.detail, consumer!.detail, edited.text);
    assert.equal(proofs().filter((f) => !before.includes(f)).length, 1, edited.text);
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
    // Tests and traces are not run on code whose proof failed (SPEC.md, "Stages of `pnpm check`").
    assert.deepEqual(failed, ["proof"]);
  });

  test("moving a line break so that a comment swallows half a guard is a change to the model", async () => {
    const failed = await failedStages("spec/index.md", (s) => s.replace("o.status == Draft and qty > 0 and o.units + qty <= maxUnits", "o.status == Draft and qty > 0 // and o.units + qty <= maxUnits"));
    assert.ok(failed.includes("review"), failed.join());
  });

  test("a comment in the Quint is reviewed, but the model it annotates is not simulated again", async () => {
    const root = copyOfProject("spec/index.md", (s) => s.replace("pure val unitPrice = 5", "pure val unitPrice = 5 /* euros */ // per unit"));
    const { failed, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
    assert.ok(!fs.existsSync(path.join(root, "gen/traces")), text);
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

  test("nested set samples stay bounded, an inner lambda may shadow a match binder, forall and subseteq keep their meaning as quantifiers, and a variant names its own module's type before one an import brings", async () => {
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
    const deep = scratch({
      "spec/codes.md": ruleSpec("type Code = Spent | Fine\npure val code: Code = Spent"),
      "spec/lib.md": ruleSpec('import codes.* from "./codes"\npure val value = 1'),
      "spec/use.md": ruleSpec('import lib.* from "./lib"\ntype Failure = Limited({ at: int }) | Spent\npure val spent: Failure = Spent\npure def lawSpent(n: int): bool = spent != Limited({ at: n })'),
    });
    const owned = await run(deep);
    assert.deepEqual(owned.failed, ["review"], owned.text);
    assert.deepEqual((await import(path.join(deep, "gen/use.ts"))).spent, { tag: "Spent" });
  });
}

function eachCheck() {
  before(async () => {
    for (const file of ["spec/index.md", "src", "test"]) fs.cpSync(path.join(EXAMPLE, file), path.join(pristine, file), { recursive: true });
    for (const [file, text] of Object.entries(PACKAGE)) fs.writeFileSync(path.join(pristine, file), text);
    fs.symlinkSync(nodeModules, path.join(pristine, "node_modules"), "dir");
    for (const spec of readSpecs(pristine)) acceptReviews(pristine, spec);
    acceptContracts(pristine);
    const began = Date.now() - 1000;
    const pristineCheck = await check(pristine);
    assert.equal(pristineCheck.ok, true, pristineCheck.results.map(show).join("\n"));
    for (const name of unused(pristine, began)) fs.rmSync(path.join(pristine, ".spec-cache", name));
  });
  for (const [shard, tests] of Object.entries(SHARDS)) describe(shard, { concurrency: LANES }, tests);

  test("install creates ignored agent aliases inside the checkout and recreates them on reinstall", () => {
    const { packageManager, scripts } = JSON.parse(read("package.json"));
    const hook = "pnpm:devPreinstall";
    const root = scratch({
      "package.json": JSON.stringify({ name: "skills", packageManager, scripts: { [hook]: scripts[hook] } }),
      "vibestack/skill-links.ts": read("vibestack/skill-links.ts"),
      "AGENTS.md": "Project instructions\n",
      ".agents/skills/project/SKILL.md": "Project skill\n",
      ".agents/claude-settings.json": read(".agents/claude-settings.json"),
    });
    const home = scratch({ ".agents/skills/personal/SKILL.md": "Personal skill\n" });
    const cache = process.env.XDG_CACHE_HOME ?? process.env.LOCALAPPDATA
      ?? path.join(os.homedir(), process.platform === "win32" ? "AppData/Local" : ".cache");
    const env = { ...process.env, HOME: home, USERPROFILE: home, COREPACK_HOME: process.env.COREPACK_HOME ?? path.join(cache, "node/corepack") };
    const install = () => {
      const result = spawnSync("pnpm", ["install", "--offline", "--ignore-workspace"], { cwd: root, encoding: "utf8", env });
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      return `${result.stdout}\n${result.stderr}`;
    };
    const git = (args: string[]) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return result.stdout.trim().split("\n").filter(Boolean);
    };
    install();
    assert.ok(fs.lstatSync(path.join(root, ".agents/skills/project")).isDirectory());
    for (const alias of harnessSkillPaths) {
      assert.equal(fs.realpathSync(path.join(root, alias)), path.join(root, ".agents/skills"));
      assert.equal(path.isAbsolute(fs.readlinkSync(path.join(root, alias))), false);
    }
    assert.equal(fs.readlinkSync(path.join(root, "CLAUDE.md")), "AGENTS.md");
    assert.equal(fs.realpathSync(path.join(root, ".claude/settings.json")), path.join(root, ".agents/claude-settings.json"));
    git(["init", "--quiet"]);
    const generated = ["CLAUDE.md", ".claude/settings.json", ...harnessSkillPaths];
    assert.deepEqual(git(["check-ignore", "--", ...generated]).sort(), generated.sort());
    assert.deepEqual(git(["ls-files", "--others", "--exclude-standard", "--", ".agents/skills"]), [".agents/skills/project/SKILL.md"]);
    for (const alias of [...harnessSkillPaths, "CLAUDE.md", ".claude/settings.json"]) fs.unlinkSync(path.join(root, alias));
    install();
    for (const alias of harnessSkillPaths) assert.equal(fs.realpathSync(path.join(root, alias)), path.join(root, ".agents/skills"));
    assert.equal(read("CLAUDE.md", root), "Project instructions\n");

    const conflict = path.join(root, ".cursor/skills/project");
    fs.unlinkSync(path.join(root, ".cursor/skills"));
    fs.mkdirSync(conflict, { recursive: true });
    fs.writeFileSync(path.join(conflict, "SKILL.md"), "My Cursor skill\n");
    const redirected = path.join(root, ".t3");
    fs.unlinkSync(path.join(redirected, "skills"));
    fs.rmdirSync(redirected);
    fs.symlinkSync(home, redirected, "dir");
    const diagnostics = install();
    assert.ok(diagnostics.includes(conflict));
    assert.ok(diagnostics.includes(redirected));
    assert.equal(fs.readFileSync(path.join(conflict, "SKILL.md"), "utf8"), "My Cursor skill\n");
    assert.equal(read(".agents/skills/project/SKILL.md", root), "Project skill\n");
    assert.deepEqual(fs.readdirSync(home).filter((name) => name === "skills" || name === ".agents" || harnessSkillPaths.some((alias) => name === alias.split("/")[0])), [".agents"]);
    assert.equal(read(".agents/skills/personal/SKILL.md", home), "Personal skill\n");
  });

  test("init exposes every skill, preserves local instructions and refreshes its marked procedure", () => {
    const root = scratch({ "AGENTS.md": "mine\n", "package.json": `{"scripts":{"check":"mine"}}` });
    const added = init(root);
    const agents = path.join(root, "AGENTS.md");
    const claude = path.join(root, "CLAUDE.md");
    const expected = `mine\n\n<!-- vibestack:start -->\n${read("AGENTS.md").trim()}\n<!-- vibestack:end -->\n`;
    assert.equal(fs.readFileSync(agents, "utf8"), expected);
    const typeReference = "vibestack/reference/typereferences.md";
    assert.ok(expected.includes(`](${typeReference})`));
    assert.equal(read(typeReference, root), read(typeReference));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts, { check: "mine", dev: "spec studio", gen: "spec gen", accept: "spec accept", build: "vibelang", test: "vitest run", postinstall: "spec init" });
    assert.deepEqual(read(".gitignore", root).trim().split("\n").sort(), [...scaffoldedIgnores].sort());
    const skills = fs.readdirSync(path.join(project, ".agents/skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    const skillFiles = filesUnder(project, ".agents/skills").filter((file) => path.basename(file) !== ".DS_Store");
    assert.deepEqual(filesUnder(root, ".agents/skills"), skillFiles);
    for (const file of skillFiles) {
      assert.deepEqual(fs.readFileSync(path.join(root, file)), fs.readFileSync(path.join(project, file)), file);
    }
    for (const dir of [project, root]) {
      for (const name of skills) {
        const canonical = path.join(dir, `.agents/skills/${name}`);
        assert.ok(fs.lstatSync(canonical).isDirectory());
        assert.equal(read(`.agents/skills/${name}/SKILL.md`, dir), read(`.agents/skills/${name}/SKILL.md`));
      }
    }
    for (const relative of harnessSkillPaths) {
      const alias = path.join(root, relative);
      assert.ok(!path.isAbsolute(fs.readlinkSync(alias)));
      assert.equal(fs.realpathSync(alias), path.join(root, ".agents/skills"));
    }
    assert.equal(fs.realpathSync(path.join(root, ".claude/settings.json")), path.join(root, ".agents/claude-settings.json"));
    assert.ok(added.includes("tsconfig.json"), added.join());
    assert.equal(fs.readlinkSync(claude), "AGENTS.md");
    assert.equal(fs.readFileSync(claude, "utf8"), expected);
    assert.deepEqual(init(root), []);
    fs.unlinkSync(claude);
    fs.writeFileSync(claude, "@AGENTS.md\r\n");
    assert.deepEqual(init(root), ["CLAUDE.md (symlink to AGENTS.md)"]);
    assert.equal(fs.readlinkSync(claude), "AGENTS.md");
    assert.deepEqual(init(root), []);
    fs.unlinkSync(claude);
    fs.writeFileSync(claude, "My existing instructions.\n");
    init(root);
    assert.equal(fs.readFileSync(claude, "utf8"), "My existing instructions.\n\n@AGENTS.md\n");
    assert.equal(fs.readFileSync(agents, "utf8"), expected);
    assert.deepEqual(init(root), []);
    fs.writeFileSync(path.join(root, ".agents/skills/sync/SKILL.md"), "My sync instructions.\n");
    const design = path.join(root, ".agents/skills/design");
    fs.writeFileSync(path.join(design, "SKILL.md"), "My design instructions.\n");
    assert.deepEqual(init(root), []);
    assert.equal(read(".agents/skills/sync/SKILL.md", root), "My sync instructions.\n");
    assert.equal(read(".agents/skills/design/SKILL.md", root), "My design instructions.\n");
    fs.writeFileSync(path.join(root, typeReference), "My type reference.\n");
    assert.deepEqual(init(root), []);
    assert.equal(read(typeReference, root), "My type reference.\n");
    const patterns = ".agents/skills/typescript-best-practices/references/patterns.md";
    const prompt = ".agents/skills/architect/references/runner-prompt.md";
    fs.writeFileSync(path.join(root, patterns), "My TypeScript examples.\n");
    fs.unlinkSync(path.join(root, prompt));
    assert.deepEqual(init(root), [prompt]);
    assert.equal(read(".agents/skills/typescript-best-practices/references/patterns.md", root), "My TypeScript examples.\n");
    assert.equal(read(".agents/skills/architect/references/runner-prompt.md", root), read(prompt));
    const otherProject = scratch({});
    const occupied = scratch({ [path.dirname(prompt)]: "My Architect references.\n" });
    fs.mkdirSync(path.join(occupied, path.dirname(path.dirname(patterns))), { recursive: true });
    fs.symlinkSync(otherProject, path.join(occupied, path.dirname(patterns)), "dir");
    init(occupied);
    assert.equal(read(path.dirname(prompt), occupied), "My Architect references.\n");
    assert.equal(fs.readlinkSync(path.join(occupied, path.dirname(patterns))), otherProject);
    assert.deepEqual(fs.readdirSync(otherProject), []);
    assert.equal(read(".agents/skills/architect/SKILL.md", occupied), read(".agents/skills/architect/SKILL.md"));
    assert.deepEqual(init(occupied), []);
    for (const directory of [".agents", ".agents/skills", ".claude", ".claude/skills"]) {
      const redirected = scratch({});
      const link = path.join(redirected, directory);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(otherProject, link, "dir");
      init(redirected, () => {});
      assert.equal(fs.readlinkSync(link), otherProject);
      assert.deepEqual(fs.readdirSync(otherProject), []);
    }
    const legacy = scratch({
      ".claude/skills/sync/SKILL.md": "My existing sync instructions.\n",
      ".claude/skills/sync/references/local.txt": "My bundled reference.\n",
      ".claude/skills/local/SKILL.md": "My local skill.\n",
      ".claude/skills/LICENSE.local": "My skill license.\n",
      ".claude/settings.json": "{}\n",
    });
    fs.mkdirSync(path.join(legacy, ".agents/skills"), { recursive: true });
    fs.symlinkSync("../../.claude/skills/sync", path.join(legacy, ".agents/skills/sync"), "dir");
    fs.mkdirSync(path.join(legacy, ".grok"));
    fs.symlinkSync("../.claude/skills", path.join(legacy, ".grok/skills"), "dir");
    init(legacy);
    assert.ok(fs.lstatSync(path.join(legacy, ".agents/skills/sync")).isDirectory());
    assert.equal(read(".agents/skills/sync/SKILL.md", legacy), "My existing sync instructions.\n");
    assert.equal(read(".agents/skills/sync/references/local.txt", legacy), "My bundled reference.\n");
    assert.equal(read(".agents/skills/local/SKILL.md", legacy), "My local skill.\n");
    assert.equal(read(".agents/skills/LICENSE.local", legacy), "My skill license.\n");
    assert.equal(read(".claude/settings.json", legacy), "{}\n");
    for (const alias of harnessSkillPaths) assert.equal(fs.realpathSync(path.join(legacy, alias)), path.join(legacy, ".agents/skills"));
    assert.deepEqual(init(legacy), []);
    const conflicting = scratch({
      ".agents/skills/sync/SKILL.md": "My canonical skill.\n",
      ".claude/skills/sync/SKILL.md": "My legacy skill.\n",
      ".claude/skills/sync/references/local.txt": "My legacy reference.\n",
    });
    const warnings: string[] = [];
    init(conflicting, (message) => warnings.push(message));
    assert.ok(warnings.some((message) => message.includes("Conflicting legacy skill content")));
    assert.equal(read(".agents/skills/sync/SKILL.md", conflicting), "My canonical skill.\n");
    assert.equal(read(".claude/skills/sync/SKILL.md", conflicting), "My legacy skill.\n");
    assert.equal(read(".agents/skills/sync/references/local.txt", conflicting), "My legacy reference.\n");
    assert.equal(fs.realpathSync(path.join(conflicting, ".claude/skills/design")), path.join(conflicting, ".agents/skills/design"));
    assert.deepEqual(init(conflicting, () => {}), []);
    fs.writeFileSync(path.join(conflicting, ".claude/skills/sync/SKILL.md"), "My canonical skill.\n");
    init(conflicting);
    assert.equal(fs.realpathSync(path.join(conflicting, ".claude/skills")), path.join(conflicting, ".agents/skills"));
    assert.deepEqual(init(conflicting), []);
    const interrupted = scratch({});
    fs.mkdirSync(path.join(interrupted, ".agents/skills"), { recursive: true });
    fs.mkdirSync(path.join(interrupted, ".claude"));
    fs.symlinkSync("../../.claude/skills/sync", path.join(interrupted, ".agents/skills/sync"), "dir");
    fs.symlinkSync("../.agents/skills", path.join(interrupted, ".claude/skills"), "dir");
    init(interrupted);
    assert.ok(fs.lstatSync(path.join(interrupted, ".agents/skills/sync")).isDirectory());
    assert.equal(read(".agents/skills/sync/SKILL.md", interrupted), read(".agents/skills/sync/SKILL.md"));
    assert.equal(fs.realpathSync(path.join(interrupted, ".claude/skills")), path.join(interrupted, ".agents/skills"));
    assert.deepEqual(init(interrupted), []);
    const legacyRoot = scratch({ ".claude/skills/local/SKILL.md": "My local skill.\n" });
    fs.mkdirSync(path.join(legacyRoot, ".agents"));
    fs.symlinkSync("../.claude/skills", path.join(legacyRoot, ".agents/skills"), "dir");
    init(legacyRoot);
    assert.ok(fs.lstatSync(path.join(legacyRoot, ".agents/skills")).isDirectory());
    assert.equal(read(".agents/skills/local/SKILL.md", legacyRoot), "My local skill.\n");
    assert.equal(fs.realpathSync(path.join(legacyRoot, ".claude/skills")), path.join(legacyRoot, ".agents/skills"));
    assert.deepEqual(init(legacyRoot), []);
    fs.writeFileSync(agents, "before\r\n<!-- vibestack:start -->\r\nold instructions\r\n<!-- vibestack:end -->\r\nafter\r\n");
    init(root);
    assert.equal(fs.readFileSync(agents, "utf8"), `before\r\n<!-- vibestack:start -->\r\n${read("AGENTS.md").trim().replace(/\r?\n/g, "\r\n")}\r\n<!-- vibestack:end -->\r\nafter\r\n`);
    assert.deepEqual(init(root), []);
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
    const [runtime, tooling] = [["effect", "@effect/platform-node", "vibelang-runtime"], ["vibelang", "vibelang-vite", "vite", "vitest", "@effect/vitest", "@types/node", "@antithesishq/bombadil"]];
    // VibeLang's packages move together, and with one version of Effect: each is pinned exactly.
    for (const name of [...runtime, ...tooling].filter((n) => n !== "@types/node")) assert.match(pins[name], /^\d+\.\d+\.\d+$/, name);
    // A workspace's `catalog:` means nothing in the package `init` writes it into.
    assert.match(pins["@types/node"], /^\^\d+\.\d+\.\d+$/);
    const one = { "@effect/platform-node-shared": pins["@effect/platform-node"] };
    const scripts = { dev: "spec studio", check: "spec check", gen: "spec gen", accept: "spec accept", build: "vibelang", test: "vitest run", postinstall: "spec init" };

    const fresh = scratch({ "package.json": '{"name":"fresh"}' });
    assert.deepEqual([...new Set(init(fresh).filter((file) => !/^\.[^/]+\/skills(?:\/|$)/.test(file)))].sort(), ["SPEC.md", "vibestack/reference/typereferences.md", ".agents/claude-settings.json", ".claude/settings.json", "AGENTS.md (Vibestack instructions)", "CLAUDE.md (symlink to AGENTS.md)",
      "tsconfig.json", "vitest.config.ts", "spec/index.md", ".gitignore", "package.json scripts: dev, check, gen, accept, build, test", "package.json postinstall: spec init",
      `package.json VibeLang toolchain: ${[...runtime, ...tooling].join(", ")} (run your package manager's install)`, "package.json packageManager: pnpm@10.24.0", "package.json engines.node: >=26", 'package.json "type": "module"'].sort());
    assert.deepEqual(json(fresh, "tsconfig.json"), {
      compilerOptions: { target: "es2023", module: "nodenext", strict: true, skipLibCheck: true, types: ["node"], rootDir: ".", rootDirs: [".", ".vibe/declarations"], outDir: "dist", noEmitOnError: true, rewriteRelativeImportExtensions: true },
      include: ["src", "test", "gen/*.ts", "gen/*.vibe"], vibe: { sidecarDir: ".vibe/declarations" },
    });
    assert.equal(read("vitest.config.ts", fresh), 'import { project } from "vibestack/testing/vitest";\n\nexport default project({ root: import.meta.dirname });\n');
    assert.deepEqual(read(".gitignore", fresh).trim().split("\n").sort(), [...scaffoldedIgnores].sort());
    assert.deepEqual(json(fresh, "package.json"), {
      name: "fresh", type: "module", packageManager: "pnpm@10.24.0", scripts, engines: { node: `>=${NODE}` },
      dependencies: pinned(...runtime), devDependencies: pinned(...tooling), pnpm: { overrides: one },
    });
    assert.ok(Object.values({ ...json(fresh, "package.json").dependencies, ...json(fresh, "package.json").devDependencies }).every((version) => typeof version === "string" && !/^(catalog|workspace):/.test(version)));
    assert.deepEqual(init(fresh), []);

    // The placeholder `npm init` writes is no test script; a script, a dependency, an override or an ignored path already there stays.
    const own = { name: "own", type: "module", scripts: { build: "mine", test: 'echo "Error: no test specified" && exit 1', postinstall: "my-install" }, engines: { node: ">=26" },
      dependencies: { effect: "mine" }, devDependencies: { vitest: "mine" }, overrides: { "@effect/platform-node-shared": "mine" }, pnpm: { overrides: { other: "mine" } } };
    const kept = scratch({ "package.json": JSON.stringify(own), "tsconfig.json": "{}\n", "vitest.config.ts": "export default {};\n", ".gitignore": "dist/\n" });
    const added = init(kept);
    assert.deepEqual([...new Set(added.filter((a) => /^(package\.json|tsconfig|vitest|\.gitignore)/.test(a)))].sort(), [".gitignore", "package.json scripts: dev, check, gen, accept, test", "package.json postinstall: spec init",
      `package.json VibeLang toolchain: ${[...runtime, ...tooling].filter((n) => n !== "effect" && n !== "vitest").join(", ")} (run your package manager's install)`, "package.json packageManager: pnpm@10.24.0"].sort());
    assert.deepEqual([read("tsconfig.json", kept), read("vitest.config.ts", kept)], ["{}\n", "export default {};\n"]);
    assert.deepEqual(read(".gitignore", kept).trim().split("\n").sort(), [...scaffoldedIgnores].sort());
    assert.deepEqual(json(kept, "package.json"), {
      ...own, packageManager: "pnpm@10.24.0", scripts: { ...scripts, build: "mine", postinstall: "spec init && my-install" }, dependencies: { ...pinned(...runtime), effect: "mine" }, devDependencies: { ...pinned(...tooling), vitest: "mine" },
      pnpm: { overrides: { ...one, other: "mine" } },
    });
    assert.deepEqual(init(kept), []);
    const template = scratch({ "package.json": JSON.stringify({ scripts: { "pnpm:devPreinstall": "node vibestack/skill-links.ts" } }) });
    init(template);
    assert.equal(json(template, "package.json").scripts.postinstall, undefined);
    assert.deepEqual(init(template), []);
    const customInstall = scratch({ "package.json": JSON.stringify({ scripts: { "pnpm:devPreinstall": "my-preinstall" } }) });
    init(customInstall);
    assert.equal(json(customInstall, "package.json").scripts["pnpm:devPreinstall"], "my-preinstall");
    assert.equal(json(customInstall, "package.json").scripts.postinstall, "spec init");
    assert.deepEqual(init(customInstall), []);
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
    let mirrored: boolean | undefined;
    const first = await run(root, "reviews", (r) => { if (["always", "sometimes", "replay"].includes(r.stage)) mirrored ??= fs.existsSync(path.join(root, "apps/app/gen/app.ts")) && read("apps/app/gen/app.ts", root) === read("gen/app.ts", root); });
    assert.deepEqual(first.failed, [], first.text);
    assert.equal(mirrored, true, "the owner's gen/ is written before any simulation is reported");
    assert.ok(fs.existsSync(path.join(root, "gen/traces")), "and the simulations' traces survive it");
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

  test("one lock holds reviews, contracts and proof acceptance and records deleted specs", async () => {
    const root = fixtures(["door"]);
    for (const spec of readSpecs(root)) acceptReviews(root, spec);
    const proof = { "door.ts": { text: "previously-reviewed", unproved: ["an obligation"] } };
    writeLedger(root, proof);
    const lockPath = path.join(root, "spec/lock.json");
    const before = JSON.parse(read("spec/lock.json", root));
    assert.deepEqual(before.unproved, proof);
    const withOldContract = JSON.stringify({ ...before, contracts: { "src/old.ts": "old-contract" } });
    fs.writeFileSync(lockPath, withOldContract);
    assert.deepEqual(pending(root, readSpecs(root)[0]), []);
    fs.rmSync(path.join(root, "spec/door.md"));
    fs.writeFileSync(path.join(root, "spec/index.md"), "");
    assert.deepEqual(pendingSpecs(root, readSpecs(root)).map((p) => p.where), ["spec/door.md"]);
    const obsolete = await run(root);
    assert.deepEqual(obsolete.failed, ["review"], obsolete.text);
    assert.match(obsolete.said("review", /obsolete simulated-only proof exception in door\.ts/)?.detail ?? "", /an obligation/, obsolete.text);
    assert.equal(read("spec/lock.json", root), withOldContract);
    const removed = await run(root, "reviews");
    assert.deepEqual(removed.failed, [], removed.text);
    const after = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.deepEqual(Object.keys(after.specs), ["spec/index.md"]);
    assert.deepEqual(pendingSpecs(root, readSpecs(root)), []);
    assert.deepEqual(after.contracts, {});
    assert.deepEqual(after.unproved, {});
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

  test("a driver reaches the application: it imports gen/ only as types, it is sent malformed input where it can receive it, and a shell without one is given one to fill in, which starts no second check in watch; a pass is remembered until what the run reads changes, and a failure runs again", async () => {
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
      run(copyOfProject("src/app.vibe", (s) => s.replace("{ type Order,", "{ type Event, type Order,").replace("const event = try decodeEvent(input)", "const event = input as Event"))),
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
    const unwatched = copyOfProject();
    fs.rmSync(path.join(unwatched, "test/drivers/index.ts"));
    const watch = watching(unwatched);
    try {
      await watch.waitFor(() => watch.checks() === 1);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      assert.equal(watch.checks(), 1, "the driver the check wrote is no change to check again");
      fs.appendFileSync(path.join(unwatched, "test/drivers/index.ts"), "// begun\n");
      await watch.waitFor(() => watch.checks() === 2);
    } finally {
      await watch.stop();
    }
    const ran = path.join(scratch({}), "ran");
    const counted = copyOfProject("test/drivers/index.ts", (s) => `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(ran)}, "x");\n${s}`);
    const driverRuns = async () => { await run(counted); return fs.readFileSync(ran, "utf8").length; };
    assert.deepEqual([await driverRuns(), await driverRuns()], [1, 1]);
    fs.writeFileSync(path.join(counted, "src/app.vibe"), read("src/app.vibe", counted).replace("{ type Order,", "{ type Event, type Order,").replace("const event = try decodeEvent(input)", "const event = input as Event"));
    assert.deepEqual([await driverRuns(), await driverRuns()], [2, 3]);
  });

  test("nothing stale survives in gen/ or hides a renamed source, and a check that changes no spec leaves gen/ as it was", async () => {
    const root = copyOfProject();
    fs.mkdirSync(path.join(root, "gen"), { recursive: true });
    for (const stale of ["renamed.ts", "renamed.effect.vibe", "index.effect.vibe.pure.d.ts"]) fs.writeFileSync(path.join(root, "gen", stale), "export const stale = true;\n");
    await check(root);
    // tsconfig.json keeps the compiler's declaration sidecars under .vibe/declarations/.
    assert.deepEqual(fs.readdirSync(path.join(root, "gen")).filter((f) => /\.(ts|vibe)$/.test(f)).sort(),
      ["_conformance.ts", "index.conformance.ts", "index.effect.vibe", "index.ts"]);
    const stamps = () => fs.readdirSync(path.join(root, "gen"), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => [e.name, fs.statSync(path.join(root, "gen", e.name)).mtimeMs]);
    const stamped = stamps();
    await check(root);
    assert.deepEqual(stamps(), stamped);
    assert.deepEqual(["gen", ".spec-cache"].flatMap((dir) => fs.readdirSync(path.join(root, dir)).filter((f) => f.startsWith("run-"))), []);
    const sidecar = path.join(root, ".vibe/declarations/src/app.d.vibe.ts");
    assert.ok(fs.existsSync(sidecar) && fs.existsSync(path.join(root, ".vibe/declarations/gen/index.effect.vibe.pure.d.ts")));
    fs.renameSync(path.join(root, "src/app.vibe"), path.join(root, "src/renamed.vibe"));
    const renamed = await check(root);
    const types = renamed.results.find((r) => r.stage === "types")!;
    assert.equal(types.ok, false, renamed.results.map(show).join("\n"));
    assert.match(types.detail, /TS2307: Cannot find module ['"][^'"]*app\.vibe['"]/);
    assert.ok(!fs.existsSync(sidecar));
  });

  test("gzip cache entries still work, truncated entries are recomputed and generated modules run in a CommonJS project", async () => {
    const root = fixtures(["door"], (f) => { f["package.json"] = '{"type":"commonjs"}'; });
    const before = await run(root);
    assert.deepEqual(before.failed, ["review"], before.text);
    const cache = path.join(root, ".spec-cache");
    const entries = () => fs.readdirSync(cache).filter((f) => f.endsWith(".json.zst")).sort();
    const initial = entries();
    assert.ok(initial.length > 0);
    for (const entry of initial) {
      const file = path.join(cache, entry);
      const legacy = file.replace(/\.zst$/, ".gz");
      fs.writeFileSync(legacy, gzipSync(zstdDecompressSync(fs.readFileSync(file))));
      fs.rmSync(file);
    }
    const legacy = await run(root);
    assert.deepEqual(legacy.results, before.results, legacy.text);
    assert.deepEqual(entries(), []);
    for (const entry of initial) {
      fs.writeFileSync(path.join(cache, entry), "{");
      fs.writeFileSync(path.join(cache, entry.replace(/\.zst$/, ".gz")), "{");
    }
    const after = await run(root);
    assert.deepEqual(after.results, before.results, after.text);
    assert.deepEqual(entries(), initial);
    for (const entry of entries()) assert.doesNotThrow(() => JSON.parse(zstdDecompressSync(fs.readFileSync(path.join(cache, entry))).toString("utf8")));
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

  test("proof caching follows library changes and the prover's own code, verifies nothing again for a change to the tools that leaves the Dafny alone, and compiler failure waits for proof completion", async () => {
    const root = toolchain(fixtures(["highest"], (f) => { f["package.json"] = '{"type":"module"}'; }), "quint", "lsc");
    const script = path.join(root, "vibestack/spec.ts");
    const first = await runCli(script, root, "check", "--json");
    const checked = answer(first.stdout);
    assert.ok(checked.results.some((r: Result) => r.stage === "proof" && r.ok), first.stdout + first.stderr);
    assert.ok(fs.existsSync(path.join(root, "gen/proof/highest/verify")), "Dafny verified the unit");
    const remembered = () => fs.readdirSync(path.join(root, ".spec-cache")).filter((f) => f.startsWith("prove-")).join();
    const proved = remembered();
    fs.appendFileSync(path.join(root, "vibestack/review.ts"), "\nexport {};\n");
    const tooled = await runCli(script, root, "check", "--json");
    assert.ok(answer(tooled.stdout).results.some((r: Result) => r.stage === "proof" && r.ok), tooled.stdout + tooled.stderr);
    assert.equal(remembered(), proved, "a change to tools the prover does not run proves nothing again");
    fs.appendFileSync(path.join(root, "vibestack/scan.ts"), "\nexport {};\n");
    const rescanned = await runCli(script, root, "check", "--json");
    assert.ok(answer(rescanned.stdout).results.some((r: Result) => r.stage === "proof" && r.ok), rescanned.stdout + rescanned.stderr);
    assert.notEqual(remembered(), proved, "a change to the prover's code proves again");
    assert.ok(!["gen", "check", "verify", "audit"].some((run) => fs.existsSync(path.join(root, "gen/proof/highest", run))), "a remembered run of LemmaScript or Dafny is not run again");
    const before = remembered();
    const marker = "// A distinct proof-library version for this scratch project.";
    fs.appendFileSync(path.join(root, "vibestack/proof/lib.dfy"), `\n${marker}\n`);
    const second = await runCli(script, root, "check", "--json");
    const again = answer(second.stdout);
    assert.ok(again.results.some((r: Result) => r.stage === "proof" && r.ok), second.stdout + second.stderr);
    assert.ok(fs.readFileSync(path.join(root, "gen/proof/highest/highest.dfy"), "utf8").includes(marker));
    // A change to the library the proof is given is proved again, and remembered beside the earlier proof.
    const entries = remembered();
    assert.notEqual(entries, before);
    // A proof is remembered for the part of the library it calls: an edit elsewhere in it proves nothing again.
    fs.writeFileSync(path.join(root, "vibestack/proof/lib.dfy"), read("vibestack/proof/lib.dfy", root).replace(`\n${marker}\n`, "").replace("\n  lemma FilterNil", `\n  ${marker}\n  lemma FilterNil`));
    const sliced = await runCli(script, root, "check", "--json");
    assert.ok(answer(sliced.stdout).results.some((r: Result) => r.stage === "proof" && r.ok), sliced.stdout + sliced.stderr);
    assert.ok(read("vibestack/proof/lib.dfy", root).includes(`  ${marker}\n  lemma FilterNil`) && !read("gen/proof/highest/highest.dfy", root).includes("lemma FilterNil"));
    const unmarked = remembered();
    fs.writeFileSync(path.join(root, "vibestack/proof/lib.dfy"), read("vibestack/proof/lib.dfy", root).replace(`  ${marker}\n`, `  ${marker} Again.\n`));
    await runCli(script, root, "check", "--json");
    assert.equal(unmarked, entries);
    assert.equal(remembered(), unmarked);
    if (process.platform !== "win32") {
      const shim = path.join(root, "node_modules/.bin/quint");
      fs.unlinkSync(shim);
      fs.copyFileSync(path.join(nodeModules, ".bin/quint"), shim);
      const retry = await exec(process.execPath, ["--input-type=module", "--eval", `
        import fs from "node:fs";
        import path from "node:path";
        import { check } from "./vibestack/formal.ts";
        let attempts = 0;
        const copy = fs.copyFileSync;
        fs.copyFileSync = (from, to, ...args) => {
          const result = copy(from, to, ...args);
          if (path.basename(to) === "highest.ts" && path.basename(path.dirname(to)).startsWith("run-") && ++attempts <= 2) fs.linkSync("node_modules/.bin/quint", "concurrent-install-" + attempts);
          return result;
        };
        let models = 0;
        const result = await check(".", false, (step) => {
          if (step.stage === "model") models++;
        });
        console.log(JSON.stringify([attempts, models, result.results.filter(s => s.stage === "model").length, result.results.filter(s => !s.ok).map(s => s.stage)]));
      `], root);
      assert.equal(retry.status, 0, retry.stderr);
      assert.deepEqual(JSON.parse(retry.stdout), [3, 1, 1, ["review"]]);
    }
    fs.writeFileSync(path.join(root, "tsconfig.json"), '{"compilerOptions":{"noEmit":true},"include":["gen/*.ts"]}');
    if (process.platform !== "win32") {
      const compiler = path.join(root, "node_modules/.bin/vibelang");
      fs.writeFileSync(compiler, "#!/bin/sh\nexit 1\n");
      fs.chmodSync(compiler, 0o644);
    }
    fs.appendFileSync(path.join(root, "spec/highest.proof.dfy"), "\nlemma RecheckedBesideTheFailedCompiler()\n  ensures true\n{\n}\n");
    const failed = await runCli(script, root, "check", "--json");
    const result = answer(failed.stdout);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.ok(result.results.some((r: Result) => r.stage === "types" && !r.ok), failed.stdout);
    assert.ok(result.results.some((r: Result) => r.stage === "proof" && r.ok), failed.stdout);
    assert.deepEqual(["gen", "check", "verify"].map((run) => fs.existsSync(path.join(root, "gen/proof/highest", run))), [false, true, true], "an edit to the proof file generates nothing again, and checks and verifies the Dafny it changed");
    assert.ok(!fs.existsSync(path.join(root, ".spec-cache/lock")));
  });

  test("a check remembers its results under the code of the tools it loaded, not their comments, and nothing when they changed as it loaded them", async () => {
    const root = toolchain(scratch({}), "quint");
    const touch = `fs.appendFileSync(${JSON.stringify(path.join(root, "vibestack/parse.ts"))}, "\\nexport {};\\n");`;
    const load = `const { entry, store } = await import(${JSON.stringify(path.join(root, "vibestack/cache.ts"))});`;
    const remember = 'const at = await entry(".", "simulate", ["same"]); store({ root: ".", fresh: false, used: new Set() }, at, 1); console.log(JSON.stringify({ name: at.name, kept: fs.existsSync(at.file) }));';
    const checked = async (...steps: string[]) => {
      const r = await exec(process.execPath, ["--input-type=module", "--eval", ['const fs = await import("node:fs");', ...steps].join("\n")], root);
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const loaded = await checked(load, touch, remember);
    assert.equal(loaded.kept, true, "a tool changed after a check loaded it leaves that check's results remembered");
    assert.notEqual((await checked(load, remember)).name, loaded.name, "under the code that computed them, not the code there now");
    assert.equal((await checked(touch, load, remember)).kept, false, "a tool changed while a check loaded it leaves nothing remembered");
    const names = 'console.log(JSON.stringify(Object.fromEntries(await Promise.all(["simulate", "tests", "explore", "action"].map(async (stage) => [stage, (await entry(".", stage, ["same"])).name])))));';
    const named = async (tool: string, appended = "\nexport {};\n") => {
      const before = await checked(load, names);
      fs.appendFileSync(path.join(root, "vibestack", tool), appended);
      return { before, after: await checked(load, names) };
    };
    const reworded = await named("run.ts", "\n\n// A comment, two lines below the code.\n");
    assert.deepEqual(reworded.after, reworded.before, "rewording a comment in a tool every stage and every run of a tool rests on keys nothing anew");
    const rerun = await named("run.ts");
    assert.ok(Object.keys(rerun.before).every((stage) => rerun.after[stage] !== rerun.before[stage]), "a change to its code keys every one anew");
    for (const tool of ["explore.ts", "stories/emit.ts", "design/tokens.ts", "testing/vitest.ts", "testing/check.ts"]) {
      const { before, after } = await named(tool);
      assert.equal(after.simulate, before.simulate, `a simulation is not keyed by ${tool}, which it does not run`);
      assert.notEqual(after.tests, before.tests, `tests may run any of the tools, ${tool} among them`);
      assert.equal(after.explore !== before.explore, tool === "explore.ts", `an exploration is keyed by the code that explores, not by ${tool} unless it explores`);
    }
    const proving = await named("prove.ts");
    assert.deepEqual([proving.after.tests !== proving.before.tests, proving.after.explore !== proving.before.explore], [true, false], "an exploration is not keyed by a tool it does not run");
    for (const tool of ["units.ts", "util.ts", "gen/harness.ts", "testing/profile.ts"]) {
      const { before, after } = await named(tool);
      assert.notEqual(after.simulate, before.simulate, `a simulation is keyed by ${tool}, which it runs`);
    }
    for (const [page, main] of [["runs", 'import "../../vibestack/spec.ts";\n'], ["plain", "export {};\n"]]) {
      fs.mkdirSync(path.join(root, page, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, page, "package.json"), "{}\n");
      fs.writeFileSync(path.join(root, page, "src/main.ts"), main);
    }
    const pages = `const { pageInputs } = await import(${JSON.stringify(path.join(root, "vibestack/explore.ts"))}); console.log(JSON.stringify(["runs", "plain"].map((page) => pageInputs(page))));`;
    const keys = await checked(pages);
    fs.appendFileSync(path.join(root, "vibestack/review.ts"), "\n// A comment, two lines below the code.\n");
    const commented = await checked(pages);
    fs.appendFileSync(path.join(root, "vibestack/review.ts"), "\nexport {};\n");
    assert.deepEqual([commented, await checked(pages)].map((after) => after.map((key: string, i: number) => key !== keys[i])), [[false, false], [true, false]],
      "a page that runs one of the tools reads the code of them all, not their comments, and a page that runs none reads none");
    fs.renameSync(path.join(root, "vibestack"), path.join(root, "src"));
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"vibestack","type":"module"}');
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(path.join(root, "dist/skill-links.js"), 'const alias = import.meta.dirname; export const dir = path.resolve(alias, "../");');
    fs.writeFileSync(path.join(root, "runs/src/main.ts"), 'import "../../dist/skill-links.js";');
    const built = await checked('const { pageInputs } = await import("./src/explore.ts"); console.log(JSON.stringify([pageInputs("runs"), typeof pageInputs("plain")]));');
    assert.deepEqual(built, [null, "string"], "a built tool with a caller-dependent directory is uncacheable and an unrelated page remains cacheable");
  });

  test("a process that outlives a reinstall of Quint, as watch does, keys what it runs and simulates by the Quint installed now, and remembers its runs again", { skip: process.platform === "win32" }, async () => {
    const root = toolchain(scratch({}), "lsc");
    const log = path.join(root, "quint.log");
    const { directory, manifest, cli } = stockQuint(root, "");
    const direct = JSON.parse(fs.readFileSync(manifest, "utf8"));
    fs.writeFileSync(manifest, JSON.stringify({ ...direct, dependencies: { ...direct.dependencies, "quint-dependency": "*" } }));
    const dependency = path.join(directory, "node_modules/quint-dependency/package.json");
    fs.mkdirSync(path.dirname(dependency), { recursive: true });
    fs.writeFileSync(dependency, JSON.stringify({ name: "quint-dependency", version: "1.0.0" }));
    const source = path.join(path.dirname(dependency), "index.js");
    fs.writeFileSync(source, "export const version = 1;\n");
    const manager = path.join(directory, "dist/src/rust/binaryManager.js");
    fs.writeFileSync(manager, "exports.QUINT_EVALUATOR_VERSION = 'v1';");
    const native = path.join(root, "quint-home/rust-evaluator-v1/quint_evaluator");
    fs.mkdirSync(path.dirname(native), { recursive: true });
    fs.writeFileSync(cli, `
      const fs = require("node:fs");
      fs.appendFileSync(${JSON.stringify(log)}, "first\\n");
      fs.writeFileSync("ir.json", "{}");
      if (process.argv[2] === "run") {
        fs.writeFileSync("0.itf.json", "{}");
        const native = ${JSON.stringify(native)};
        if (!fs.existsSync(native)) fs.writeFileSync(native, "initial", { mode: 0o755 });
      }
    `);
    const script = [
      'const fs = await import("node:fs");',
      `const { act } = await import(${JSON.stringify(path.join(root, "vibestack/action.ts"))});`,
      `const { entry, steady, remembered } = await import(${JSON.stringify(path.join(root, "vibestack/cache.ts"))});`,
      'const memory = { root: ".", fresh: false, used: new Set() };',
      `const runs = async () => { await act(memory, "quint", ["typecheck"], "typed", { "a.qnt": { text: "module a {}", key: "a" } }); return fs.readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n"); };`,
      'const simulation = async () => (await entry(".", "simulate", ["same"])).name;',
      'const said = { before: [await runs(), await runs()], simulation: await simulation() };',
      `fs.writeFileSync(${JSON.stringify(cli)}, fs.readFileSync(${JSON.stringify(cli)}, "utf8").replace('"first', '"second'));`,
      `fs.writeFileSync(${JSON.stringify(manifest)}, JSON.stringify({ ...JSON.parse(fs.readFileSync(${JSON.stringify(manifest)}, "utf8")), version: "0.0.0-reinstalled" }));`,
      'const reinstalled = await steady(async () => ({ after: [await runs(), await runs()], reinstalled: await simulation(), proof: (await entry(".", "prove", ["same"])).name }));',
      `fs.writeFileSync(${JSON.stringify(dependency)}, JSON.stringify({ name: "quint-dependency", version: "1.0.1" }));`,
      'const dependency = await steady(async () => ({ runs: [await runs(), await runs()], simulation: await simulation(), proof: (await entry(".", "prove", ["same"])).name }));',
      `fs.writeFileSync(${JSON.stringify(source)}, "export const version = 2;\\n");`,
      'const patched = await steady(async () => ({ runs: [await runs(), await runs()], simulation: await simulation() }));',
      `process.env.QUINT_HOME = ${JSON.stringify(path.join(root, "quint-home"))};`,
      `const native = ${JSON.stringify(native)};`,
      'const simulate = (schedule, scope = memory, after) => steady(async () => {',
      '  const key = await entry(".", "simulate", ["native"]);',
      '  await remembered(scope, key, (child) => act(child, "quint", ["run"], "simulated", {}), (r) => r.ok, schedule);',
      '  after?.();',
      `  return { key: key.name, saved: fs.existsSync(key.file), runs: fs.readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").length };`,
      '});',
      'const bootstrap = await simulate(), installed = await simulate(), warm = await simulate();',
      'const rotate = () => { fs.renameSync(native, native + ".old"); fs.writeFileSync(native, "changed", { mode: 0o755 }); };',
      'const restore = () => fs.renameSync(native + ".old", native);',
      'const rotated = await simulate(undefined, memory, rotate).then(() => "", (error) => error.message); restore();',
      'const restored = await simulate(undefined, memory, () => { rotate(); restore(); }).then(() => "", (error) => error.message);',
      'const held = await entry(".", "simulate", ["native"]);',
      'const bytes = fs.readFileSync(held.file);',
      'const { used } = JSON.parse((await import("node:zlib")).zstdDecompressSync(bytes));',
      'fs.unlinkSync(held.file);',
      'for (const name of used) fs.rmSync(".spec-cache/"+name, { force: true });',
      'const scope = { ...memory, used: new Set() };',
      'const late = await simulate(async (resume) => { fs.writeFileSync(held.file, bytes); return resume(true); }, scope);',
      'const retained = used.length > 0 && used.every((name) => scope.used.has(name) && !fs.existsSync(".spec-cache/"+name));',
      'fs.writeFileSync(native, "replacement"); const replaced = await simulate(); fs.writeFileSync(native, "replacement");',
      'const identical = await simulate(); process.env.QUINT_HOME = "quint-home";',
      'console.log(JSON.stringify({ ...said, ...reinstalled, dependency, patched, rotated, restored, late, retained, evaluations: [bootstrap, installed, warm, replaced, identical, await simulate()] }));',
    ].join("\n");
    const r = await exec(process.execPath, ["--input-type=module", "--eval", script], root);
    assert.equal(r.status, 0, r.stderr);
    const said = JSON.parse(r.stdout);
    assert.deepEqual(said.before, [["first"], ["first"]], "a run is remembered");
    assert.deepEqual(said.after, [["first", "second"], ["first", "second"]], "the Quint installed since runs, and its run is remembered");
    assert.notEqual(said.reinstalled, said.simulation, "a simulation is keyed by the Quint installed now");

    assert.notEqual(said.dependency.simulation, said.reinstalled, "a dependency reinstalled under the same Quint launcher changes the simulation identity");
    assert.equal(said.dependency.proof, said.proof, "the independent LemmaScript proof stays current");
    assert.deepEqual(said.dependency.runs, [["first", "second", "second"], ["first", "second", "second"]], "Quint runs again for the changed dependency, once");

    assert.notEqual(said.patched.simulation, said.dependency.simulation, "a same-version change to installed dependency code invalidates the simulation");
    assert.deepEqual(said.patched.runs, [said.dependency.runs[1].concat("second"), said.dependency.runs[1].concat("second")]);

    const [bootstrap, installed, warm, replaced, identical, relative] = said.evaluations;
    assert.equal(bootstrap.saved, false, "a simulation that installed its own evaluator is not a receipt for a missing evaluator");
    assert.equal(installed.saved, true);
    assert.equal(installed.runs, bootstrap.runs + 1, "the installed evaluator runs once for its own identity");
    assert.deepEqual(warm, installed);
    for (const changed of [said.rotated, said.restored]) assert.match(changed, /tool installation changed/);
    assert.deepEqual(said.late, warm, "a queued simulation reuses an aggregate published before its native work starts");
    assert.equal(said.retained, true, "the hit retains its action dependencies without recreating them");
    assert.equal(replaced.runs, warm.runs + 1);
    assert.notEqual(replaced.key, warm.key, "changing only evaluator bytes changes the simulation identity");
    assert.deepEqual(identical, replaced, "identical executable bytes still reuse the result");
    assert.equal(relative.saved, false, "a relative QUINT_HOME resolves in the child's working directory and cannot use the supervisor's evaluator");

    const shims = path.join(scratch({}), "node_modules/.bin");
    fs.mkdirSync(shims, { recursive: true });
    for (const tool of ["lsc", "bombadil"]) fs.copyFileSync(path.join(nodeModules, ".bin", tool), path.join(shims, tool));
    const explorer = path.join(root, "node_modules/@antithesishq/bombadil/package.json");
    const shipped = fs.readFileSync(path.join(nodeModules, "@antithesishq/bombadil/package.json"), "utf8");
    fs.unlinkSync(path.join(root, "node_modules/@antithesishq"));
    fs.mkdirSync(path.dirname(explorer), { recursive: true });
    const identities = async (version?: string) => {
      fs.writeFileSync(explorer, JSON.stringify({ ...JSON.parse(shipped), version }));
      const r = await exec(process.execPath, ["--input-type=module", "--eval", `const { installedPackages } = await import(${JSON.stringify(path.join(root, "vibestack/cache.ts"))});
        console.log(JSON.stringify([installedPackages(${JSON.stringify(path.join(shims, "lsc"))}, "lemmascript"), installedPackages(${JSON.stringify(path.join(shims, "bombadil"))}, "@antithesishq/bombadil")]));`], root);
      return r.status === 0 ? JSON.parse(r.stdout) : r.stderr;
    };
    const version = JSON.parse(shipped).version;
    const [lemmascript, bombadil] = await identities(version);
    assert.ok(lemmascript.some((p: string) => p.startsWith("lemmascript@")), "a launcher whose package is installed only beside these tools is told apart by the package they load");
    assert.ok(bombadil.includes(`@antithesishq/bombadil@${version}`), JSON.stringify(bombadil));
    assert.notDeepEqual((await identities("0.0.0-reinstalled"))[1], bombadil, "an exploration is keyed by the Bombadil installed now");
    assert.match(await identities(), /no @antithesishq\/bombadil with a version is installed/, "and a Bombadil of no version is no key");
  });

  test("a change to the tools or the prose that leaves the Quint alone runs no Quint again, nor a simulation for prose that only moves the rules, and its results cite the rules where they now are", { skip: process.platform === "win32" }, async () => {
    const root = toolchain(oneRule("index", "Small", "pure val initial: int = 0\npure def up(n: int): int = n + 1\npure def alwaysSmall(n: int): bool = n < 3"));
    const log = path.join(root, "quint.log");
    stockQuint(root, `require("node:fs").appendFileSync(${JSON.stringify(log)}, process.argv[2] + "\\n");`);
    const checked = async () => {
      fs.rmSync(log, { force: true });
      const { stdout } = await runCli(path.join(root, "vibestack/spec.ts"), root, "check", "--json");
      return { broken: answer(stdout).results.find((r: Result) => r.stage === "always"), ran: [...(fs.existsSync(log) ? read("quint.log", root).trim().split("\n") : []), ...(fs.existsSync(path.join(root, "gen/traces")) ? ["simulate"] : [])] };
    };
    const first = await checked();
    assert.match(first.broken?.summary ?? "", /"Story \/ Small" \(spec\/index\.md:5\)/, JSON.stringify(first.broken));
    assert.deepEqual([...new Set(first.ran)].sort(), ["simulate", "typecheck"]);
    assert.deepEqual((await checked()).ran, []);
    fs.appendFileSync(path.join(root, "vibestack/review.ts"), "\nexport {};\n");
    const tooled = await checked();
    assert.deepEqual(tooled, { broken: first.broken, ran: [] });
    fs.writeFileSync(path.join(root, "spec/index.md"), read("spec/index.md", root).replace("### Small\n", "Prose above the rule.\n\n### Small\n"));
    const simulations = () => fs.readdirSync(path.join(root, ".spec-cache")).filter((f) => f.startsWith("simulate-")).sort();
    const simulated = simulations();
    const generated = read("gen/index.ts", root);
    const moved = await checked();
    assert.deepEqual(moved.ran, []);
    assert.deepEqual(simulations(), simulated, "prose that only moves a rule is no new simulation");
    assert.equal(read("gen/index.ts", root), generated, "nor new generated code, nor a typecheck, test or exploration keyed by it");
    assert.match(moved.broken?.summary ?? "", /"Story \/ Small" \(spec\/index\.md:7\)/, JSON.stringify(moved.broken));
    fs.writeFileSync(path.join(root, "spec/index.md"), read("spec/index.md", root).replace("### Small\n", "### Tiny\n"));
    const renamed = await checked();
    assert.equal(simulations().length, simulated.length + 1, "a rule renamed is simulated again");
    assert.match(renamed.broken?.summary ?? "", /"Story \/ Tiny" \(spec\/index\.md:7\)/, JSON.stringify(renamed.broken));
  });

  test("a Quint string ends at its next quote, as Quint reads it, and a change inside one is simulated again", async () => {
    const quint = (b: string) => `pure val b: str = if (1 == 2) "p\\" else "${b}"\npure val initial: int = 0\npure def up(n: int): int = n + 1\npure def alwaysSame(n: int): bool = b == "x // y"`;
    const root = oneRule("index", "Same", quint("x // y"));
    const first = await run(root);
    assert.ok(!first.failed.includes("always"), first.text);
    fs.writeFileSync(path.join(root, "spec/index.md"), ruleSpec(quint("x // z"), "Same"));
    const changed = await run(root);
    assert.equal(changed.said("always", /alwaysSame|"Story \/ Same"/)?.ok, false, changed.text);
  });

  test("a verifier process that outlives a change to LemmaScript classifies obligations with the installed emitter", { skip: process.platform === "win32" }, async () => {
    const root = toolchain(scratch({ "package.json": '{"type":"module"}' }), "lsc");
    const launcher = path.join(root, "node_modules/.bin/lsc");
    fs.unlinkSync(launcher);
    fs.writeFileSync(launcher, `#!/bin/sh\nexec "${path.join(nodeModules, ".bin/lsc")}" "$@"\n`, { mode: 0o755 });
    const helper = path.join(root, "node_modules/.bin/dafny-emit.js");
    fs.writeFileSync(helper, 'export { DAFNY_HELPER_NAMES } from "./names.mjs";');
    const names = path.join(path.dirname(helper), "names.mjs");
    fs.writeFileSync(names, "export const DAFNY_HELPER_NAMES = new Set();");
    const probe = await exec(process.execPath, ["--input-type=module", "--eval", `
      import fs from "node:fs";
      import { prove } from "./vibestack/prove.ts";
      import { steady } from "./vibestack/cache.ts";
      const text = ${JSON.stringify(ONE)};
      const unit = { unit: "one.ts", text, src: true, proofFile: "src/one.proof.dfy", imports: { text: "", lemmas: [] }, rests: [], externs: [], assumed: [], meaning: text };
      const run = () => steady(() => prove({ root: process.cwd(), fresh: false, used: new Set() }, unit, { axioms: [] }));
      const first = await run();
      fs.writeFileSync(${JSON.stringify(names)}, 'export const DAFNY_HELPER_NAMES = new Set(["one_ensures"]);');
      const next = await run();
      process.stdout.write(JSON.stringify([first, next].map(({ total, unproved, errors }) => [total, unproved, errors])));
    `], root);
    assert.equal(probe.status, 0, probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout), [[1, [], []], [0, [], []]]);
  });

  test("proof and task cache identity follows verifier and compiler bytes rather than installation directories, read again only once they change", { skip: process.platform === "win32" }, async () => {
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
      fs.writeFileSync(path.join(directory, "dafny"), "#!/bin/sh\necho >> \"$(dirname \"$0\").asked\"\nprintf '4.11.0\\n'\n", { mode: 0o755 });
      fs.writeFileSync(path.join(directory, "z3"), `#!/bin/sh\n${name === "changed" ? "# a different solver build\n" : ""}printf 'Z3 version 4.12.1\\n'\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(directory, "Dafny.dll"), name === "assemblies" ? "another verifier" : "the verifier");
      fs.writeFileSync(path.join(directory, "System.Private.CoreLib.dll"), "the self-contained runtime");
      fs.writeFileSync(path.join(directory, "Support.dll"), "a supporting assembly");
    }
    const script = `const fs = await import("node:fs"); const { entry, toolchainFingerprint } = await import(${JSON.stringify(path.join(project, "vibestack/cache.ts"))}); const proof = async () => (await entry(".", "prove", ["same obligation"])).name; const tests = (await entry(".", "tests", ["same"])).name; const before = await proof(); const unchanged = await proof(); const file = process.env.REINSTALL; const original = file && fs.existsSync(file) ? fs.readFileSync(file) : undefined; if (file) fs.writeFileSync(file, "the verifier, reinstalled"); const task = await toolchainFingerprint(); const reinstalled = await proof(); if (file) { if (original) fs.writeFileSync(file, original); else fs.rmSync(file); } console.log(JSON.stringify({ proof: before, unchanged, tests, task, reinstalled, restored: await proof() }));`;
    const said = path.join(root, "cache/vibestack/toolchain.json");
    const keyed = async (name: string, reinstall?: string) => {
      const result = await exec(process.execPath, ["--input-type=module", "--eval", script], root,
        { ...process.env, XDG_CACHE_HOME: path.join(root, "cache"), PATH: `${path.join(root, name)}${path.delimiter}${process.env.PATH ?? ""}`, ...reinstall ? { REINSTALL: reinstall } : {} });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const keys = [];
    for (const name of names) keys.push(await keyed(name));
    assert.deepEqual(keys[0], keys[1], "moving the same tools preserves proof and task results");
    const unavailable = await exec(process.execPath, ["--input-type=module", "--eval", [
      `const { entry, toolchainFingerprint } = await import(${JSON.stringify(path.join(project, "vibestack/cache.ts"))});`,
      'const task = await toolchainFingerprint();',
      'const proof = await entry(".", "prove", ["same obligation"]).then(() => "accepted", (error) => error.message);',
      'console.log(JSON.stringify({ task, proof }));',
    ].join("\n")], root, { ...process.env, PATH: path.join(root, "without-verifiers") });
    assert.equal(unavailable.status, 0, unavailable.stderr);
    const omitted = JSON.parse(unavailable.stdout);
    assert.equal(omitted.task.dafny, null);
    assert.equal(omitted.task.z3, null);
    assert.notDeepEqual(omitted.task, keys[0].task);
    assert.match(omitted.proof, /Dafny is not on PATH|the proof stage needs the Z3 solver/);
    for (const other of keys.slice(2)) {
      assert.notEqual(keys[0].proof, other.proof, "different verifier bytes invalidate a proof even at the same version");
      assert.notEqual(keys[0].tests, other.tests, "and tests, which may run proofs");
      assert.notDeepEqual(keys[0].task, other.task, "different verifier bytes invalidate a task even at the same version");
    }
    const asked = () => read("first.asked", root).length;
    const remembered = JSON.parse(fs.readFileSync(said, "utf8"));
    const solver = Object.keys(remembered).find((key) => key.startsWith("sha256 ") && key.endsWith(`${path.sep}first${path.sep}z3`))!;
    fs.writeFileSync(said, JSON.stringify({ ...remembered, [solver]: { ...remembered[solver], value: "f".repeat(64) } }));
    const before = asked();
    const warm = await keyed("first");
    assert.equal(warm.task.z3.digest, "f".repeat(64), "a later process reuses what an earlier one read of an unchanged installation");
    assert.equal(asked(), before, "and does not ask Dafny its version again");
    fs.writeFileSync(path.join(root, "first/Dafny.dll"), "the verifieR");
    fs.writeFileSync(path.join(root, "first/z3"), read("first/z3", root).replace("printf", "printf "));
    const rewritten = await keyed("first");
    assert.notEqual(rewritten.proof, keys[0].proof, "a verifier rewritten in place, at the same size, is read again");
    assert.notEqual(rewritten.task.z3.digest, "f".repeat(64), "and so is a solver");
    assert.equal(asked(), before + 1, "and Dafny is asked its version again");
    assert.match(keys[0].task.node.digest, /^[a-f0-9]{64}$/);
    assert.match(keys[0].task.vibelang.digest, /^[a-f0-9]{64}$/);
    assert.equal(keys[0].reinstalled, keys[0].proof);
    for (const file of ["Dafny.dll", "System.Private.CoreLib.dll", "Support.dll", "Added.dll"]) {
      const watched = await keyed("first", path.join(root, "first", file));
      assert.equal(watched.unchanged, watched.proof, "an unchanged installation keeps the proof key within one process");
      assert.notEqual(watched.reinstalled, watched.proof, `a process that outlives a change to ${file}, as watch does, keys by the Dafny installed now`);
      assert.equal(watched.restored, watched.proof, `restoring ${file}, or removing it when it was added, restores the original proof key`);
    }
    const audit = path.join(root, "audit");
    fs.cpSync(path.join(root, "first"), audit, { recursive: true });
    fs.writeFileSync(path.join(audit, "dafny"), "#!/bin/sh\nif [ \"$1\" = audit ]; then\n  [ -n \"$REWRITE\" ] && printf x >> \"$(dirname \"$0\")/Dafny.dll\"\n  echo 'Dafny auditor completed'\nelse printf '4.11.0\\n'; fi\n", { mode: 0o755 });
    const checked = await exec(process.execPath, ["--input-type=module", "--eval", [
      'const fs = await import("node:fs");',
      `const { act } = await import(${JSON.stringify(path.join(project, "vibestack/action.ts"))});`,
      `const { entry, steady, solver, store } = await import(${JSON.stringify(path.join(project, "vibestack/cache.ts"))});`,
      'const memory = { root: ".", fresh: false, used: new Set() };',
      'const proof = async () => (await entry(".", "prove", ["same obligation"])).name;',
      'const outcome = (work) => steady(work).then(() => "certified", (error) => error.message);',
      'const audit = () => act(memory, "dafny", ["audit", "a.dfy"], "audited", { "a.dfy": { text: "", key: "a" } });',
      'const kept = async () => { const result = await outcome(audit); return [result, fs.existsSync(".spec-cache") ? fs.readdirSync(".spec-cache").filter((f) => f.startsWith("action-")).length : 0]; };',
      'let within; const changedDuring = await outcome(async () => { const before = await proof(); fs.writeFileSync("audit/Support.dll", "installed again during the check"); within = [before, await proof()]; });',
      'const after = await proof();',
      'process.env.REWRITE = "1";',
      'const rewritten = await kept();',
      'delete process.env.REWRITE;',
      'const keptAfter = await kept();',
      'const restored = await outcome(async () => { await audit(); const file = "audit/z3"; const original = fs.readFileSync(file); fs.appendFileSync(file, " "); fs.writeFileSync(file, original); });',
      'const warm = await outcome(async () => { await audit(); fs.appendFileSync("audit/Support.dll", " changed after a warm hit"); });',
      'const published = await steady(async () => { await proof(); const entries = await Promise.all(Array.from({length: 64}, (_, i) => entry(".", "action", ["batch", String(i)]))); for (const e of entries) store(memory, e, "verified", "dafny"); return entries.filter(e => fs.existsSync(e.file)).length; });',
      'const choose = () => steady(async () => [(await solver()).version, await proof()]);',
      'const bundled = "libexec/z3/bin/z3-4.12.1"; fs.mkdirSync("libexec/z3/bin", { recursive: true });',
      'const install = (v) => { fs.writeFileSync(bundled + ".next", ["#!/bin/sh", "echo Z3 version " + v, ""].join(String.fromCharCode(10)), { mode: 0o755 }); fs.renameSync(bundled + ".next", bundled); };',
      'const fallback = await choose(); install("4.12.0"); const preferred = await choose(); install("4.12.2"); const replaced = await choose(); fs.unlinkSync(bundled);',
      'console.log(JSON.stringify({ within, after, changedDuring, restored, warm, published, kept: [rewritten, keptAfter], selected: [fallback, preferred, replaced, await choose()] }));',
    ].join("\n")], root, { ...process.env, XDG_CACHE_HOME: path.join(root, "cache"), PATH: `${audit}${path.delimiter}${process.env.PATH ?? ""}` });
    assert.equal(checked.status, 0, checked.stderr);
    const steadily = JSON.parse(checked.stdout);
    assert.equal(steadily.within[1], steadily.within[0], "a check reads Dafny's installation once");
    assert.notEqual(steadily.after, steadily.within[0], "and the next reads it again");
    assert.equal(steadily.published, 64, "certified native actions are published in bounded batches");
    for (const changed of [steadily.changedDuring, steadily.restored, steadily.warm]) assert.match(changed, /tool installation changed/);
    assert.deepEqual(steadily.kept, [["a tool installation changed during this check; run the check again", 0], ["certified", 1]], "a run of Dafny during which it was installed again is not remembered, though its check read the installation before");
    const selected: [string, string][] = steadily.selected;
    assert.deepEqual(selected.map(([version]) => version), ["4.12.1", "4.12.0", "4.12.2", "4.12.1"], "a preferred bundled solver is discovered, updated, and removed between checks");
    assert.equal(new Set(selected.map(([, proof]) => proof)).size, 3, "each installed solver has its own proof identity");
    assert.deepEqual(selected[0], selected[3], "removing the preferred solver restores the previous proof identity");
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
    const recent = path.join(root, `.spec-cache/prove-${"1".repeat(24)}.json.gz`);
    const expired = path.join(root, `.spec-cache/prove-${"2".repeat(24)}.json.gz`);
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
    const newer = path.join(root, `.spec-cache/prove-${"3".repeat(24)}.json.zst`);
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
    const staging = scratch(Object.fromEntries(PACKED.map((file) => [file, read(file)])));
    // Studio's page is built from the workspace packages it shares with every interface.
    for (const directory of ["vibestack", "packages", "spec"].filter((d) => fs.existsSync(path.join(project, d))))
      copySources(path.join(project, directory), path.join(staging, directory));
    copySources(path.join(project, ".agents/skills"), path.join(staging, ".agents/skills"));
    const lock = path.join(staging, "vibestack/studio/.spec-cache/lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, `${process.pid}\n`);
    fs.mkdirSync(path.join(staging, "node_modules"));
    fs.writeFileSync(path.join(staging, "node_modules/should-not-copy"), "dependencies belong to the scratch install\n");
    const copy = scratch({ ".gitignore": read(".gitignore") });
    copySources(staging, copy);
    const fixture = "vibestack/stories/test/fixtures/gen/index.ts";
    assert.deepEqual(fs.readFileSync(path.join(copy, fixture)), fs.readFileSync(path.join(project, fixture)));
    assert.ok(!fs.existsSync(path.join(copy, "vibestack/studio/.spec-cache/lock")));
    assert.ok(!fs.existsSync(path.join(copy, "node_modules")));
    assert.equal(read("vibestack/gen/typescript.ts", copy), read("vibestack/gen/typescript.ts"));
    for (const directory of ["vibestack/studio", ...fs.readdirSync(path.join(copy, "packages")).map((name) => `packages/${name}`)])
      for (const output of ["gen", "dist", "generated", "node_modules", ".spec-cache", ".cache", ".vibe", ".turbo", "storybook-static"])
        assert.ok(!fs.existsSync(path.join(copy, directory, output)), `${directory}/${output} is produced by the scratch build`);
    const modulesManifest = path.join(nodeModules, ".modules.yaml");
    assert.ok(fs.existsSync(modulesManifest), "The packaged command selftest needs a pnpm workspace install. Run pnpm install.");
    const { parse: parseYaml } = await import("yaml");
    const storeDir = (parseYaml(fs.readFileSync(modulesManifest, "utf8")) as { storeDir?: unknown } | null)?.storeDir;
    assert.ok(typeof storeDir === "string" && path.isAbsolute(storeDir), `Missing absolute pnpm store path in ${modulesManifest}`);
    const installEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase().replaceAll("-", "_") !== "npm_config_store_dir"));
    installEnv.npm_config_store_dir = storeDir;
    const dependencies = await exec(process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"], copy, installEnv);
    assert.equal(dependencies.status, 0, dependencies.stdout + dependencies.stderr);
    const page = path.join(copy, "vibestack/studio/dist/page");
    const pageFiles = (directory: string) => fs.readdirSync(directory, { recursive: true, encoding: "utf8" })
      .filter((file) => fs.statSync(path.join(directory, file)).isFile()).sort()
      .map((file) => ({ file: file.split(path.sep).join("/"), bytes: fs.readFileSync(path.join(directory, file)) }));
    const studio = await exec(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["all", "vibestack-studio#build"], copy, { ...process.env, TURBO_CACHE: "local:rw" });
    assert.equal(studio.status, 0, studio.stdout + studio.stderr);
    const currentPage = pageFiles(page);
    const stale = ["assets/stale-bundle.js", "assets/stale-style.css", "removed-public.txt"];
    for (const file of stale) {
      fs.mkdirSync(path.dirname(path.join(page, file)), { recursive: true });
      fs.writeFileSync(path.join(page, file), "obsolete build output\n");
    }
    const built = await exec(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["run", "build"], copy, { ...process.env, TURBO_CACHE: "local:rw" });
    assert.equal(built.status, 0, built.stdout + built.stderr);
    assert.match(stripVTControlCharacters(built.stdout), /^(?:vibestack-studio:build: |::group::vibestack-studio:build\r?\n)cache hit\b/m);
    assert.deepEqual(stale.filter((file) => fs.existsSync(path.join(page, file))), stale);
    const script = path.join(copy, "dist/spec.js");
    fs.chmodSync(script, 0o755);
    const generated = await exec(process.platform === "win32" ? process.execPath : script,
      [...(process.platform === "win32" ? [script] : []), "gen", root], copy);
    assert.equal(generated.status, 0, generated.stdout + generated.stderr);
    assert.equal((await import(path.join(root, "gen/packaged.ts"))).answer, 42);

    // pnpm exposes transitive executables as regular shims while keeping their package beside the tool's dependency.
    const consumer = oneRule("arithmetic", "A value equals itself", "pure def lawIdentity(n: int): bool = n == n");
    const installed = path.join(consumer, "node_modules/vibestack");
    const archive = path.join(copy, "toolchain.tgz");
    const packed = await exec(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["pack", "--config.ignore-scripts=true", "--out", archive], copy);
    assert.equal(packed.status, 0, packed.stdout + packed.stderr);
    fs.mkdirSync(installed, { recursive: true });
    const unpacked = await exec("tar", ["-xzf", archive, "--strip-components", "1", "-C", installed], copy);
    assert.equal(unpacked.status, 0, unpacked.stdout + unpacked.stderr);
    assert.deepEqual(pageFiles(path.join(installed, "dist/studio/dist/page")), currentPage);
    assert.deepEqual(fs.readdirSync(installed, { recursive: true, encoding: "utf8" }).filter((file) => file.split(path.sep).includes("examples")), [], "an application's toolchain carries no example to check");
    fs.mkdirSync(path.join(installed, "node_modules"));
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
    const scaffold = scratch({});
    const initialized = await runCli(path.join(installed, "dist/spec.js"), scaffold, "init");
    assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
    for (const file of [".agents/skills/LICENSE.pstack", ".agents/skills/architect/references/runner-prompt.md", ".agents/skills/typescript-best-practices/references/patterns.md", "vibestack/reference/typereferences.md"]) {
      assert.equal(read(file, scaffold), read(file));
    }
    for (const alias of harnessSkillPaths) assert.equal(fs.realpathSync(path.join(scaffold, alias)), path.join(scaffold, ".agents/skills"));
    assert.ok(!fs.existsSync(path.join(installed, ".claude")));
    assert.ok(!fs.existsSync(path.join(installed, "CLAUDE.md")));
    const manifest = JSON.parse(read("package.json", scaffold));
    for (const field of ["dependencies", "devDependencies"])
      for (const name of Object.keys(manifest[field])) manifest[field][name] = JSON.parse(fs.readFileSync(path.join(nodeModules, name, "package.json"), "utf8")).version;
    const sourceManifest = JSON.parse(read("package.json"));
    const dependencyDirectories = Object.keys(sourceManifest.dependencies).map((name) => {
      const directory = fs.realpathSync(path.join(nodeModules, name));
      manifest.pnpm.overrides[`${sourceManifest.name}@${sourceManifest.version}>${name}`] = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")).version;
      return directory;
    });
    dependencyDirectories.push(...Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).map((name) => fs.realpathSync(path.join(nodeModules, name))));
    const visited = new Set<string>();
    for (const directory of dependencyDirectories) {
      if (visited.has(directory)) continue;
      visited.add(directory);
      const pkg = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
      const modules = path.resolve(directory, ...pkg.name.split("/").map(() => ".."));
      for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
        const file = path.join(modules, name, "package.json");
        if (!fs.existsSync(file) && name in (pkg.optionalDependencies ?? {})) continue;
        assert.ok(fs.existsSync(file), `${pkg.name}@${pkg.version}: installed dependency ${name} is missing`);
        const dependency = JSON.parse(fs.readFileSync(file, "utf8"));
        manifest.pnpm.overrides[`${pkg.name}@${pkg.version}>${name}`] = dependency.name === name ? dependency.version : `npm:${dependency.name}@${dependency.version}`;
        dependencyDirectories.push(fs.realpathSync(path.dirname(file)));
      }
    }
    manifest.devDependencies.vibestack = `file:${archive}`;
    fs.writeFileSync(path.join(scaffold, "package.json"), JSON.stringify(manifest));
    fs.writeFileSync(path.join(scaffold, ".agents/skills/sync/SKILL.md"), "My installed project instructions.\n");
    for (const alias of [...harnessSkillPaths, "CLAUDE.md", ".claude/settings.json"]) fs.unlinkSync(path.join(scaffold, alias));
    const reinstalled = await exec(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["install", "--prefer-offline", "--ignore-workspace", `--config.cache-dir=${scratch({})}`], scaffold);
    assert.equal(reinstalled.status, 0, reinstalled.stdout + reinstalled.stderr);
    for (const alias of harnessSkillPaths) assert.equal(fs.realpathSync(path.join(scaffold, alias)), path.join(scaffold, ".agents/skills"));
    assert.equal(fs.readlinkSync(path.join(scaffold, "CLAUDE.md")), "AGENTS.md");
    assert.equal(fs.realpathSync(path.join(scaffold, ".claude/settings.json")), path.join(scaffold, ".agents/claude-settings.json"));
    assert.equal(read(".agents/skills/sync/SKILL.md", scaffold), "My installed project instructions.\n");
    assert.ok(!fs.existsSync(path.join(consumer, "node_modules/lemmascript")));
    const checked = await runCli(path.join(installed, "dist/spec.js"), consumer, "check", "--json");
    const proof = answer(checked.stdout).results.find((result: Result) => result.stage === "proof");
    assert.ok(proof?.ok, checked.stdout + checked.stderr);
    assert.match(proof.summary, /all 1 obligations proved/);

    const shared = path.join(consumer, ".formal-actions");
    const api = await exec(process.execPath, ["--input-type=module", "--eval", `
      import { check, withFormalCache } from "vibestack/formal";
      const { results } = await withFormalCache(${JSON.stringify(shared)}, () => check(process.cwd()));
      console.log(JSON.stringify(results.find((result) => result.stage === "proof")));
    `], consumer);
    assert.equal(api.status, 0, api.stderr);
    assert.deepEqual(JSON.parse(api.stdout), proof);
    assert.ok(fs.readdirSync(shared).some(isActionEntry), "the packed check keeps its formal actions in the caller's shared cache");
  });

  test("owner generation mirrors the same artifact as the whole tree and checks its dependency closure", async () => {
    const root = toolchain(scratch({
      "package.json": JSON.stringify({ ...JSON.parse(PACKAGE["package.json"]), specOwners: { target: "packages/plugin-target" } }),
      "packages/plugin-target/package.json": JSON.stringify({ name: "@repo/target" }),
      "packages/other/package.json": JSON.stringify({ name: "@repo/other" }),
      "spec/index.md": "# Project",
      "spec/target/index.md": ruleSpec('import lib.* from "../lib"\npure val targetValue = baseValue'),
      "spec/lib.md": ruleSpec("pure val baseValue = 1"),
      "spec/other/index.md": ruleSpec("pure val otherValue = 2"),
    }), "quint", "lsc");
    const script = path.join(root, "vibestack/spec.ts");
    const linkDuringGeneration = (phase: string) => {
      if (process.platform === "win32") return;
      const shim = path.join(root, "node_modules/.bin/quint");
      fs.unlinkSync(shim);
      fs.writeFileSync(shim, `#!/bin/sh\nln "$0" '${path.join(root, phase)}' 2>/dev/null || true\nexec '${path.join(nodeModules, ".bin/quint")}' "$@"\n`, { mode: 0o755 });
    };
    linkDuringGeneration("install-during-full-generation");
    const all = await runCli(script, root, "gen");
    assert.equal(all.status, 0, all.stdout + all.stderr);
    const target = path.join(root, "packages/plugin-target/gen");
    const outputs = () => fs.readdirSync(target).sort().map((name) => [name, fs.readFileSync(path.join(target, name), "utf8")]);
    const expected = outputs();
    const unrelated = path.join(root, "packages/other/gen/other.ts");
    const before = fs.readFileSync(unrelated, "utf8");
    fs.rmSync(target, { recursive: true });
    fs.appendFileSync(path.join(root, "spec/other/index.md"), "\n[Missing](./missing.md)\n");
    linkDuringGeneration("install-during-owner-generation");
    const scoped = await runCli(script, root, "gen", "--owner", "target");
    assert.equal(scoped.status, 0, scoped.stdout + scoped.stderr);
    assert.deepEqual(outputs(), expected);
    assert.equal(fs.readFileSync(unrelated, "utf8"), before);
    const fullCheck = await runCli(script, root, "check");
    assert.equal(fullCheck.status, 1, fullCheck.stdout + fullCheck.stderr);
    assert.match(fullCheck.stdout, /spec\/other\/index\.md.*no spec at this path/);
    fs.writeFileSync(path.join(root, "spec/other/index.md"), ruleSpec('pure val otherValue: int = "invalid"'));
    fs.appendFileSync(path.join(root, "spec/target/index.md"), "\n[Other](../other)\n");
    const linked = await runCli(script, root, "gen", "--owner", "target");
    assert.equal(linked.status, 0, linked.stdout + linked.stderr);
    assert.deepEqual(outputs(), expected);
    assert.equal(fs.readFileSync(unrelated, "utf8"), before);
    const whole = await runCli(script, root, "gen");
    assert.equal(whole.status, 1, whole.stdout + whole.stderr);
    assert.match(whole.stderr, /spec\/other\/index\.md/);
    fs.appendFileSync(path.join(root, "spec/lib.md"), "\n[Missing](./missing.md)\n");
    const broken = await runCli(script, root, "gen", "--owner", "target");
    assert.equal(broken.status, 1, broken.stdout + broken.stderr);
    assert.match(broken.stderr, /spec\/lib\.md.*no spec at this path/);
    assert.deepEqual(outputs(), expected);
    fs.writeFileSync(path.join(root, "spec/lib.md"), ruleSpec("pure val baseValue = 2"));
    fs.writeFileSync(path.join(root, "spec/target/invalid.md"), ruleSpec('pure val invalid: int = "s"'));
    const invalid = await runCli(script, root, "gen", "--owner", "target");
    assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
    assert.match(invalid.stderr, /spec\/target\/invalid\.md/);
    assert.deepEqual(outputs(), expected);

    const mapped = toolchain(scratch({
      "package.json": JSON.stringify({ ...JSON.parse(PACKAGE["package.json"]), specOwners: { target: "packages/plugin-target" } }),
      "packages/plugin-target/package.json": JSON.stringify({ name: "@repo/target" }),
      "packages/target/package.json": JSON.stringify({ name: "@repo/conventional" }),
      "spec/index.md": "# Project",
      "spec/target/index.md": ruleSpec("pure val targetValue = 1"),
    }), "quint", "lsc");
    const mappedGen = await runCli(path.join(mapped, "vibestack/spec.ts"), mapped, "gen", "--owner", "target");
    assert.equal(mappedGen.status, 0, mappedGen.stdout + mappedGen.stderr);
    assert.ok(fs.existsSync(path.join(mapped, "packages/plugin-target/gen/target.ts")));
    assert.ok(!fs.existsSync(path.join(mapped, "packages/target/gen")));
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
    const checked = answer((await cli(parent, "check", "a project", "--json")).stdout);
    assert.deepEqual([...new Set(checked.results.filter((r: Result) => !r.ok).map((r: Result) => r.stage))], ["review"], JSON.stringify(checked, null, 2));
    for (const stage of ["model", "always", "sometimes", "replay", "proof"]) assert.ok(checked.results.some((r: Result) => r.stage === stage && r.ok), stage);
    assert.match(checked.next, /pnpm accept/);
    assert.ok(fs.existsSync(path.join(root, "gen/tally.ts")));
    assert.ok(!fs.existsSync(path.join(parent, "gen")));
    const accepted = await cli(parent, "accept", root);
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    assert.ok(fs.existsSync(path.join(root, "spec/lock.json")));
    assert.ok(!fs.existsSync(path.join(parent, "spec")));
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
    const { said, checks, waitFor, stop } = watching(watchedRoot, parent);
    try {
      await waitFor(() => checks() >= 1);
      fs.writeFileSync(path.join(watchedRoot, "spec/index.md"), ruleSpec("pure val watchedValue = 1", "Value", "Watched"));
      const generated = path.join(watchedRoot, "gen/index.ts");
      await waitFor(() => fs.existsSync(generated) && fs.readFileSync(generated, "utf8").includes("export const watchedValue"));
      await waitFor(() => checks() >= 2);
      assert.equal((await import(generated)).watchedValue, 1);
      assert.ok(!fs.existsSync(path.join(parent, "gen")));
      const runs = checks();
      fs.mkdirSync(path.join(watchedRoot, "spec/app"));
      fs.writeFileSync(path.join(watchedRoot, "spec/app/index.md"), "");
      await waitFor(() => checks() > runs);
      fs.mkdirSync(path.join(watchedRoot, "apps/app"), { recursive: true });
      fs.writeFileSync(path.join(watchedRoot, "apps/app/package.json"), '{"name":"watched-app","type":"module"}');
      await waitFor(() => said.output.includes("apps/app: skipped: there is no tsconfig.json"));
      said.output = "";
      fs.writeFileSync(path.join(watchedRoot, "apps/app/tsconfig.json"), '{"compilerOptions":{"unknownOption":true}}');
      await waitFor(() => said.output.includes("apps/app: application does not fit the generated contract"));
      assert.match(said.output, /Unknown compiler option 'unknownOption'/);
      // Any file a stage reads starts a run, not only a spec, source or configuration: a recorded trace, a page, a stylesheet, and one removed.
      for (const [file, change] of [["test/traces/index.jsonl", "{}\n"], ["test/traces/index.jsonl", "{}\n{}\n"], ["index.html", "<!doctype html>\n"], ["apps/app/style.css", "a {}\n"], ["index.html", undefined]] as const) {
        await waitFor(() => said.output.trimEnd().endsWith("Ctrl-C to stop)"));
        const before = checks();
        if (change === undefined) fs.rmSync(path.join(watchedRoot, file));
        else {
          fs.mkdirSync(path.dirname(path.join(watchedRoot, file)), { recursive: true });
          fs.writeFileSync(path.join(watchedRoot, file), change);
        }
        await waitFor(() => checks() > before);
      }
    } finally {
      await stop();
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
}

function theCommandLine() {
  test("concurrent verifier installs during simulation and tests retry without duplicating the check JSON stream", { skip: process.platform === "win32" }, async () => {
    for (const changedModel of [false, true]) {
      const root = toolchain(changedModel ? oneRule("value", "A value", "pure val answer = 42") : fixtures(["door"]), "quint", "lsc");
      const shim = path.join(root, "node_modules/.bin/quint");
      fs.unlinkSync(shim);
      fs.copyFileSync(path.join(nodeModules, ".bin/quint"), shim);
      if (!changedModel) {
        const { packageManager } = JSON.parse(read("package.json"));
        fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module", packageManager, scripts: { test: "node install-during-tests.mjs" } }));
        fs.writeFileSync(path.join(root, "install-during-tests.mjs"), `
          import fs from "node:fs";
          fs.mkdirSync(".cache", { recursive: true });
          if (!fs.existsSync(".cache/test-runs")) fs.linkSync("node_modules/.bin/quint", ".cache/second-install-quint");
          fs.appendFileSync(".cache/test-runs", "ran\\n");
        `);
      }
      const retry = await exec(process.execPath, ["--input-type=module", "--eval", `
        import assert from "node:assert/strict";
        import fs from "node:fs";
        import path from "node:path";
        import { main } from "./vibestack/pipeline.ts";
        const attempts = new Set();
        let linked = false;
        const link = () => {
          fs.linkSync("node_modules/.bin/quint", "second-install-quint");
          linked = true;
        };
        const { mkdirSync } = fs;
        fs.mkdirSync = (dir, ...args) => {
          if (typeof dir === "string" && path.basename(dir).startsWith("run-")) attempts.add(dir);
          if (!linked && typeof dir === "string" && dir.split(path.sep).includes("door.inv.step")) link();
          return mkdirSync(dir, ...args);
        };
        const { log } = console;
        console.log = (line) => {
          if (${changedModel} && JSON.parse(line).stage === "model" && !linked) {
            link();
            fs.renameSync("spec/value.md", "spec/renamed.md");
          }
          log(line);
        };
        await main(["check", "--json"]);
        assert.equal(attempts.size, 3);
      `], root);
      assert.equal(retry.status, 1, retry.stdout + retry.stderr);
      const rows = retry.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
      if (changedModel) {
        assert.match(retry.stderr.trim(), /^a tool installation changed during this check; run the check again$/);
        assert.ok(rows.every((row) => typeof row.stage === "string"), "a changed prefix never gets a final answer");
      } else {
        assert.equal(retry.stderr, "");
        assert.deepEqual(rows.slice(0, -1), rows.at(-1).results);
        for (const stage of ["always", "tests"]) assert.deepEqual(rows.filter((r) => r.stage === stage).map((r) => r.ok), [true]);
        assert.equal(read(".cache/test-runs", root), "ran\nran\n");
        assert.ok(rows.at(-1).results.some((r: Result) => r.stage === "proof" && r.ok), retry.stdout);
      }
      assert.equal(rows.filter((row) => row.stage === "model").length, 1);
      assert.ok(!fs.existsSync(path.join(root, ".spec-cache/lock")));
    }
  });

  test("usage lists every command, check --json prints a line for each result and then the whole answer, and gen runs under the project's lock", async () => {
    const script = path.join(project, "vibestack/spec.ts");
    const root = oneRule("value", "A value", "pure val answer = 42");
    const help = await runCli(script, root, "--help");
    assert.equal(help.status, 0, help.stderr);
    for (const command of ["check", "watch", "gen", "accept", "new", "init", "studio", "tests", "stories", "tokens"]) assert.match(help.stdout, new RegExp(`^  ${command} `, "m"));
    const bare = await runCli(script, root);
    assert.deepEqual([bare.status, bare.stdout, bare.stderr], [2, "", help.stdout]);
    const lines = (await runCli(script, root, "check", "--json")).stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(Object.keys(lines.at(-1)), ["ok", "results", "next"]);
    assert.deepEqual(lines.slice(0, -1), lines.at(-1).results);
    // A manifest that is not JSON is a result like any other, not an exception on the way to the scripts it names.
    fs.writeFileSync(path.join(root, "package.json"), "{");
    const broken = await runCli(script, root, "check", "--json");
    assert.equal(broken.status, 1, broken.stderr);
    assert.match(answer(broken.stdout).results[0].summary, /package\.json: /);
    assert.deepEqual(fs.readdirSync(path.join(root, "gen")).filter((f) => f.startsWith("run-")), []);
    fs.rmSync(path.join(root, "package.json"));
    const generatedFile = path.join(root, "gen/value.ts");
    const generatedBefore = () => {
      const { ino, mtimeNs } = fs.statSync(generatedFile, { bigint: true });
      return [ino, mtimeNs, fs.readFileSync(generatedFile, "utf8")];
    };
    const stable = generatedBefore();
    fs.writeFileSync(path.join(root, "gen/stale.ts"), "");
    assert.equal((await runCli(script, root, "gen")).status, 0);
    assert.equal(fs.existsSync(path.join(root, "gen/stale.ts")), false);
    assert.deepEqual(generatedBefore(), stable);
    fs.mkdirSync(path.join(root, "gen/proof"), { recursive: true });
    fs.writeFileSync(path.join(root, "gen/proof/value.log"), "prior proof");
    fs.writeFileSync(path.join(root, "spec/value.md"), ruleSpec("pure val answer = 43", "A value"));
    const invalidLater = path.join(root, "spec/zBroken.md");
    fs.writeFileSync(invalidLater, ruleSpec("pure val answer = nope", "A value"));
    const strict = await runCli(script, root, "gen");
    assert.equal(strict.status, 1, strict.stdout + strict.stderr);
    assert.deepEqual(generatedBefore(), stable);
    assert.equal(fs.readFileSync(path.join(root, "gen/proof/value.log"), "utf8"), "prior proof");
    fs.rmSync(invalidLater);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const traces = path.join(root, "gen/traces");
      const trace = path.join(traces, "previous.itf.json");
      fs.mkdirSync(traces, { recursive: true });
      fs.writeFileSync(trace, "{}");
      fs.chmodSync(traces, 0o500);
      try {
        const failed = await runCli(script, root, "gen");
        assert.equal(failed.status, 1, failed.stdout + failed.stderr);
        assert.match(failed.stderr, /(?:EACCES|EPERM|ENOTEMPTY).*gen\/traces/);
        assert.deepEqual(generatedBefore(), stable);
        assert.equal(fs.readFileSync(trace, "utf8"), "{}");
      } finally {
        fs.chmodSync(traces, 0o700);
      }
    }
    // A spec invalid in the middle of an edit leaves gen/ as it was.
    fs.writeFileSync(path.join(root, "spec/value.md"), ruleSpec("pure val answer = nope", "A value"));
    assert.match((await runCli(script, root, "gen", "--if-valid")).stdout, /gen\/ was not generated/);
    assert.deepEqual(generatedBefore(), stable);
    const build = "node -e \"require('fs').writeFileSync('tools-built', '')\"";
    const owner = "node -e \"require('fs').copyFileSync('owner-source', 'owner-generated')\"";
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "install-gen", packageManager: JSON.parse(read("package.json")).packageManager,
      scripts: { gen: "node vibestack/spec.ts gen", build, owner } }));
    fs.writeFileSync(path.join(root, "turbo.json"), JSON.stringify({ tasks: {
      "//#gen": { inputs: ["spec/**"], outputs: ["gen/**"] }, "//#build": { inputs: ["package.json"], cache: false },
      "//#owner": { inputs: ["owner-source", "package.json"], cache: false },
    } }));
    fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: [packages/*]\n");
    fs.mkdirSync(path.join(root, "packages/app"), { recursive: true });
    fs.writeFileSync(path.join(root, "packages/app/package.json"), JSON.stringify({ name: "app" }));
    fs.symlinkSync(nodeModules, path.join(root, "node_modules"), "dir");
    fs.symlinkSync(path.dirname(script), path.join(root, "vibestack"), "dir");
    const install = (env: NodeJS.ProcessEnv, ...tasks: string[]) => exec(process.execPath, [script, "gen", "--install", ...tasks], root, { ...process.env, TURBO_CACHE: "local:rw", TURBO_TOKEN: "", ...env });
    const prepare = (hosted: boolean, job = "verify", ...tasks: string[]) => install({ GITHUB_ACTIONS: String(hosted), GITHUB_JOB: job }, ...tasks);
    const nightly = {
      GITHUB_ACTIONS: "true", GITHUB_JOB: "vibestack-nightly-check", GITHUB_REPOSITORY: "owner/project", GITHUB_WORKSPACE: root,
      GITHUB_WORKFLOW_REF: "owner/project/.github/workflows/fuzz.yml@refs/heads/main", npm_command: "install", npm_lifecycle_event: "prepare",
    };
    for (const hosted of [false, true]) {
      const invalid = await prepare(hosted);
      assert.equal(invalid.status, 0, invalid.stderr);
      assert.match(invalid.stdout, /gen\/ was not generated/);
      assert.equal((await import(path.join(root, "gen/value.ts"))).answer, 42);
    }
    fs.writeFileSync(path.join(root, "spec/value.md"), ruleSpec("pure val answer = 43", "A value"));
    fs.rmSync(path.join(root, "gen/value.ts"));
    const prerequisites = ["//#build", "//#owner"];
    const fixtures = await prepare(true, "vibestack-fixture-selftests", ...prerequisites);
    assert.equal(fixtures.status, 0, fixtures.stderr);
    assert.ok(fs.existsSync(path.join(root, "tools-built")));
    assert.ok(!fs.existsSync(path.join(root, "gen/value.ts")));
    const simulations = {
      ...nightly, GITHUB_JOB: "vibestack-precompute-simulations",
      GITHUB_WORKFLOW_REF: "owner/project/.github/workflows/ci.yml@refs/heads/main",
    };
    fs.rmSync(path.join(root, "tools-built"));
    const precomputed = await install(simulations, ...prerequisites);
    assert.equal(precomputed.status, 0, precomputed.stderr);
    assert.ok(!fs.existsSync(path.join(root, "tools-built")));
    assert.ok(!fs.existsSync(path.join(root, "gen/value.ts")));
    for (const outside of [
      { GITHUB_JOB: "simulate" }, { GITHUB_ACTIONS: "false" }, { GITHUB_WORKSPACE: path.dirname(root) },
      { GITHUB_WORKFLOW_REF: "owner/project/.github/workflows/other.yml@refs/heads/main" },
      { npm_lifecycle_event: "" }, { npm_command: "pack" },
    ]) {
      const required = await install({ ...simulations, ...outside }, ...prerequisites);
      assert.notEqual(required.status, 0, `an install outside the precompute context runs its prerequisites: ${JSON.stringify(outside)}`);
      assert.ok(!fs.existsSync(path.join(root, "gen/value.ts")));
    }
    for (const hosted of [false, true]) {
      const missing = await prepare(hosted, "verify", ...prerequisites);
      assert.notEqual(missing.status, 0, "a failed prerequisite fails ordinary installs");
      assert.ok(!fs.existsSync(path.join(root, "gen/value.ts")));
    }
    const missing = await install(nightly, ...prerequisites);
    assert.notEqual(missing.status, 0, "a failed prerequisite also fails nightly installs");
    fs.writeFileSync(path.join(root, "owner-source"), "nightly owner");
    const deferred = await install(nightly, ...prerequisites);
    assert.equal(deferred.status, 0, deferred.stderr);
    assert.equal(fs.readFileSync(path.join(root, "owner-generated"), "utf8"), "nightly owner");
    assert.ok(!fs.existsSync(path.join(root, "gen/value.ts")));
    const nested = await install({ ...nightly, GITHUB_WORKSPACE: path.dirname(root) });
    assert.equal(nested.status, 0, nested.stderr);
    assert.equal((await import(path.join(root, "gen/value.ts") + "?nested")).answer, 43);
    fs.rmSync(path.join(root, "gen/value.ts"));
    fs.writeFileSync(path.join(root, "owner-source"), "external owner");
    const packable = ["--skip-gen-on-pack", ...prerequisites];
    const packed = await install({ GITHUB_ACTIONS: "true", GITHUB_JOB: "verify", npm_command: "pack", npm_lifecycle_event: "prepare" }, ...packable);
    assert.equal(packed.status, 0, packed.stderr);
    assert.equal(fs.readFileSync(path.join(root, "owner-generated"), "utf8"), "external owner");
    assert.ok(!fs.existsSync(path.join(root, "gen/value.ts")));
    fs.writeFileSync(path.join(root, "owner-source"), "installed owner");
    const installed = await prepare(true, "verify", ...packable);
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(fs.readFileSync(path.join(root, "owner-generated"), "utf8"), "installed owner");
    assert.doesNotMatch(installed.stdout, /gen\/ was not generated/);
    assert.equal((await import(path.join(root, "gen/value.ts") + "?installed")).answer, 43);
    fs.rmSync(path.join(root, "gen/value.ts"));
    const restored = await prepare(true);
    assert.match(restored.stdout, /cache hit/);
    assert.equal((await import(path.join(root, "gen/value.ts") + "?restored")).answer, 43);
    fs.writeFileSync(path.join(root, ".spec-cache/lock"), `${process.pid}\n`);
    assert.match((await runCli(script, root, "gen")).stderr, /another check or accept is running in this project/);
  });

  test("init gives a directory without a manifest one", () => {
    const root = scratch({});
    assert.ok(init(root).includes("package.json scripts: dev, check, gen, accept, build, test"));
    assert.deepEqual(Object.keys(JSON.parse(read("package.json", root))).sort(), ["dependencies", "devDependencies", "engines", "packageManager", "pnpm", "scripts", "type"]);
  });

  test("an obligation not proved names its rules and leaves a lemma to start from; its acceptance outlives a change of prose and not one of Quint", async () => {
    const root = fixtures(["highest"], (f) => { delete f["spec/highest.proof.dfy"]; });
    const rule = "Running maximum / The highest of a list is at least where it starts";
    const { results } = await check(root);
    const unproved = results.find((r) => r.stage === "proof" && !r.ok);
    assert.deepEqual(unproved?.rules, [{ file: "spec/highest.md", key: rule }], results.map(show).join("\n"));
    assert.match(unproved!.detail, /gen\/proof\/highest\/highest\.scaffold\.dfy/);
    // The scaffold is a proof file as it stands: the generated header, and a body to fill.
    const scaffold = read("gen/proof/highest/highest.scaffold.dfy", root);
    assert.equal(scaffold, "lemma lawTheHighestIsAtLeastTheStart_ensures(xs: seq<int>, start: int)\n  ensures (lawTheHighestIsAtLeastTheStart(xs, start) == true)\n{\n}\n");
    assert.deepEqual(parseProofFile(scaffold, "spec/highest.proof.dfy").map((l) => l.name), ["lawTheHighestIsAtLeastTheStart_ensures"]);
    // A simulated rule's result names it too.
    fs.writeFileSync(path.join(root, "spec/highest.md"), read("spec/highest.md", root).replace(">= start", "> start"));
    assert.deepEqual((await check(root)).results.find((r) => r.stage === "always" && !r.ok)?.rules, [{ file: "spec/highest.md", key: rule }]);
    fs.writeFileSync(path.join(root, "spec/highest.md"), read("vibestack/fixtures/highest.md"));
    const accepted = await run(root, "unproved");
    assert.ok(accepted.said("proof", /^spec\/lock\.json: 1 added, 0 removed/), accepted.text);
    fs.writeFileSync(path.join(root, "spec/highest.md"), read("spec/highest.md", root).replace("A library whose law", "Reworded.\n\nA library whose law").replace("pure def highest", "/// The running maximum.\npure def highest"));
    const reworded = await run(root);
    assert.ok(reworded.said("proof", /^highest\.ts: 1 obligations, of which 1 are simulated only \(accepted\)/), reworded.text);
    fs.writeFileSync(path.join(root, "spec/highest.md"), read("spec/highest.md", root).replace("if (x > top) x else top", "if (top < x) x else top"));
    const remodelled = await run(root);
    assert.equal(remodelled.said("proof", /^highest\.ts: 1 of 1 obligations not proved; the 1 accepted earlier were accepted for another text/)?.ok, false, remodelled.text);
    const ledger = read("spec/lock.json", root);
    const refused = await run(root, "reviews");
    assert.equal(refused.failed.includes("proof"), true, refused.text);
    assert.equal(read("spec/lock.json", root), ledger);

    fs.writeFileSync(path.join(root, "spec/highest.md"), read("vibestack/fixtures/highest.md"));
    fs.writeFileSync(path.join(root, "spec/highest.proof.dfy"), read("vibestack/fixtures/highest.proof.dfy"));
    const proved = await run(root);
    assert.deepEqual(proved.failed, ["review"], proved.text);
    assert.match(proved.said("review", /^spec\/lock\.json: 1 obsolete simulated-only proof exception in highest\.ts/)?.detail ?? "", /lawTheHighestIsAtLeastTheStart/, proved.text);
    assert.equal(read("spec/lock.json", root), ledger);
    const signed = await run(root, "reviews");
    assert.deepEqual(signed.failed, [], signed.text);
    assert.ok(signed.said("proof", /^spec\/lock\.json: 0 added, 1 removed/), signed.text);
    assert.deepEqual(JSON.parse(read("spec/lock.json", root)).unproved, {});
    const checked = await run(root);
    assert.deepEqual(checked.failed, [], checked.text);
  });

  test("every operator the translator supports is used by the ops fixture, which is simulated, replayed and proved; what the proof takes as given, Node's code checks", async () => {
    const root = fixtures(["ops"]);
    const { failed, said, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
    assert.ok(said("replay", /every law, and \d+ definitions/)?.ok, text);
    assert.ok(said("proof", /^ops\.ts: all \d+ obligations proved/), text);
    const ir = await typecheckAll({ root, fresh: true, used: new Set() }, readSpecs(root)).get("ops")!;
    const used = new Set(JSON.stringify(ir).match(/"opcode":"[^"]+"/g)!.map((m) => m.slice(10, -1)));
    assert.deepEqual([...OPERATORS].filter((op) => !used.has(op)), []);
    const source = read("vibestack/fixtures/ops.md");
    assert.deepEqual([...Object.keys(LIST_HELPERS), ...Object.keys(BUILTINS)].filter((name) => !source.includes(`.${name}(`)), []);
    // Unguarded, each of these stops the simulator and cannot be proved; in a program it must not give undefined, NaN or Infinity.
    const partial = oneRule("partial", "Partial", `pure def at(xs: List[int], i: int): int = xs.nth(i)
pure def first(xs: List[int]): int = xs.head()
pure def held(m: int -> int, k: int): int = m.get(k)
pure def over(a: int, b: int): int = a / b
pure def left(a: int, b: int): int = a % b`);
    const model = await gen(partial, parseSpec(partial, "spec/partial.md"));
    const got = await import(path.join(partial, "gen/partial.ts"));
    assert.deepEqual([got.at([1, 2], 1), got.first([3]), got.held({ 1: 4 }, 1), got.over(-7, 2), got.left(-7, 2)], [2, 3, 4, -3, -1]);
    for (const reads of [() => got.at([1], 1), () => got.at([1], -1), () => got.first([]), () => got.held({ 1: 4 }, 2), () => got.over(1, 0), () => got.left(1, 0)]) assert.throws(reads, RangeError);
    assert.doesNotMatch(model.render(""), /RangeError|function (nth|get)_/);
  });

  test("what is read out of a list, set or map of secrets is a secret", async () => {
    const cards = (quint: string) => run(oneRule("cards", "Cards", `type SecretCard = str\n${quint}`));
    const leaks = [
      'pure def leak(cards: List[SecretCard]): str = if (cards.length() > 0) cards.nth(0) else ""',
      'pure def leak(cards: List[SecretCard]): str = cards.nthOr(0, "")',
      'pure def leak(cards: str -> SecretCard, k: str): str = cards.getOr(k, "")',
      "pure def leak(cards: Set[SecretCard], c: str): bool = cards.contains(c)",
      'pure def leak(c: SecretCard): str = List(c).nthOr(0, "")',
    ];
    const [kept, ...leaked] = await Promise.all(['pure def first(cards: List[SecretCard]): SecretCard = cards.nthOr(0, "")\npure def more(cards: List[SecretCard], c: SecretCard): List[SecretCard] = cards.append(c)', ...leaks].map(cards));
    assert.deepEqual(kept.failed, ["review"], kept.text);
    leaks.forEach((quint, i) => assert.equal(leaked[i].said("model", /\bleak \(spec\/cards\.md:\d+\): (what it returns depends on a secret|a secret reaches an element)/)?.ok, false, `${quint}\n${leaked[i].text}`));
  });

  test("a machine is kept in a store from one run to the next and steps from what another machine stored since, and a package that depends on react gets a hook over its machine, in an owner's gen/ as in its own", async () => {
    const manifest = (name: string) => JSON.stringify({ name, type: "module", dependencies: { react: "19" } });
    const root = scratch({
      "package.json": manifest("kept"),
      "tsconfig.json": PACKAGE["tsconfig.json"],
      "spec/index.md": ruleSpec(COUNTER),
      "spec/vault.md": read("vibestack/fixtures/vault.md"),
      "spec/lib.md": read("vibestack/fixtures/lib.md"),
      "src/kept.vibe": `import * as KeyValueStore from "effect/persistence/KeyValueStore"
import { Machine, stored } from "../gen/index.effect.vibe"

effect function once() {
  provide stored("n") { return try (try Machine).send({ type: "inc" }) }
}

/** One more, in a store that holds \`before\` under the machine's key: what came of it, and what the store holds after. */
export effect function counted(before: string | undefined) {
  provide KeyValueStore.layerMemory {
    const store = try KeyValueStore.KeyValueStore
    if (before !== undefined) try store.set("n", before)
    const outcome = once() catch (error) => error._tag
    return [outcome, try store.get("n")] as const
  }
}

/** Two pages open on one store, the later counting first: what the earlier finds and counts, what the later is then refused, and what the store holds. */
export effect function twoPages() {
  provide KeyValueStore.layerMemory {
    const store = try KeyValueStore.KeyValueStore
    provide stored("n") {
      const earlier = try Machine
      provide stored("n") {
        const later = try Machine
        try later.send({ type: "inc" })
        const found = try earlier.get()
        const second = try earlier.send({ type: "inc" })
        const refused = later.send({ type: "inc" }) catch (error) => error._tag
        return [found, second, refused, try store.get("n")] as const
      }
    }
  }
}
`,
      "src/shown.ts": `import type { ManagedRuntime } from "effect";
import type { Machine } from "../gen/index.effect.vibe";
import { useMachine } from "../gen/index.react.ts";
import type { Machine as Vault } from "../gen/vault.effect.vibe";
import { useMachine as useVault } from "../gen/vault.react.ts";

/** What a component reads and offers: the count, and the vault to its owner. */
export function useShown(counter: ManagedRuntime.ManagedRuntime<Machine, never>, vault: ManagedRuntime.ManagedRuntime<Vault, never>) {
  const { state, cause, can, send } = useMachine(counter);
  const held = useVault(vault);
  const count: number | undefined = state;
  return { count, cause, more: can({ type: "inc" }) ? () => send({ type: "inc" }) : undefined, open: held.can({ type: "open" }, "Owner") ? () => held.send({ type: "open" }, "Owner") : undefined };
}
`,
    });
    // Studio depends on react, so its packages, with the tools' own beside them, are the ones a package with a React interface resolves.
    const modules = path.join(root, "node_modules");
    fs.mkdirSync(modules);
    for (const dir of [path.join(project, "vibestack/studio/node_modules"), nodeModules])
      for (const entry of fs.readdirSync(dir)) if (!fs.existsSync(path.join(modules, entry))) fs.symlinkSync(path.join(dir, entry), path.join(modules, entry));
    // A library has no machine, and so no hook.
    assert.deepEqual((await genAll(root)).filter((f) => f.endsWith(".react.ts")), ["index.react.ts", "vault.react.ts"]);
    const compiled = await tool("vibelang", ["--noEmit", "-p", "."], root);
    assert.ok(compiled.ok, compiled.out);
    // Nothing stored starts from `initial`, and a stored state goes on from where it was; what the rules refuse, or what is no state, leaves the store as it is; a machine steps from what another over the same store stored since, and its guard is judged by it.
    const kept = await exec(process.execPath, ["--import", "vibelang/register", "--input-type=module", "-e", `import assert from "node:assert/strict"; import { Effect } from "effect"; import { counted, twoPages } from "./src/kept.vibe";
assert.deepEqual(await Promise.all([undefined, "1", "2", "7", "{"].map((before) => Effect.runPromise(counted(before)))), [[1, "1"], [2, "2"], ["Rejected", "2"], ["NotAState", "7"], ["NotAState", "{"]]);
assert.deepEqual(await Effect.runPromise(twoPages()), [1, 2, "Rejected", "2"]);
const { machineOver } = await import("./gen/index.effect.vibe");
const { Deferred, Fiber, Ref } = await import("effect");
const outcome = await Effect.runPromise(Effect.gen(function*() {
  const kept = yield* Ref.make(0);
  const firstSaving = yield* Deferred.make();
  const resume = yield* Deferred.make();
  const machine = yield* machineOver(() => Ref.get(kept), (n) => Effect.gen(function*() {
    if (n === 1) {
      yield* Deferred.succeed(firstSaving, undefined);
      yield* Deferred.await(resume);
    }
    yield* Ref.set(kept, n);
  }));
  const first = yield* Effect.forkChild(machine.send({ type: "inc" }));
  yield* Deferred.await(firstSaving);
  let source = "first";
  const pending = yield* Effect.forkChild(Effect.flip(machine.send({ type: "inc" }, () => source === "first")), { startImmediately: true });
  source = "replacement";
  yield* Deferred.succeed(resume, undefined);
  yield* Fiber.join(first);
  return [(yield* Fiber.join(pending))._tag, yield* machine.get(), yield* machine.send({ type: "inc" }, (current) => current === 1)];
}));
assert.deepEqual(outcome, ["Rejected", 1, 2]);`], root);
    assert.equal(kept.status, 0, kept.stdout + kept.stderr);
    // An owner's package.json decides for its own gen/, whatever the root's says.
    const tree = scratch({ "spec/index.md": "# Product\n", "spec/app/index.md": ruleSpec(COUNTER), "spec/plain/index.md": ruleSpec(COUNTER), "apps/app/package.json": manifest("@scratch/app"), "apps/plain/package.json": "{}" });
    assert.deepEqual((await genAll(tree)).filter((f) => f.endsWith(".react.ts")), []);
    mirrorGen(tree, readSpecs(tree));
    assert.deepEqual(["app", "plain"].map((name) => fs.readdirSync(path.join(tree, "apps", name, "gen")).filter((f) => /\.(react\.ts|effect\.vibe)$/.test(f))), [["app.effect.vibe", "app.react.ts"], ["plain.effect.vibe"]]);
    // Generating again rewrites only what changed, so what watches gen/ hears of nothing else, and removes what it no longer writes.
    const gens = ["gen", "apps/app/gen", "apps/plain/gen"].map((dir) => path.join(tree, dir));
    const stamps = () => gens.map((dir) => Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.statSync(path.join(dir, f)).mtimeMs])));
    fs.writeFileSync(path.join(tree, "apps/app/gen/stale.ts"), "");
    const [rootBefore, appBefore, plainBefore] = stamps();
    const plainText = read("apps/plain/gen/plain.ts", tree);
    fs.writeFileSync(path.join(tree, "spec/plain/index.md"), ruleSpec(COUNTER.replace("n < 2", "n < 1")));
    await genAll(tree);
    mirrorGen(tree, readSpecs(tree));
    const [rootAfter, appAfter, plainAfter] = stamps();
    delete appBefore["stale.ts"];
    assert.deepEqual([appAfter, rootAfter["app.ts"], Object.keys(plainAfter)], [appBefore, rootBefore["app.ts"], Object.keys(plainBefore)]);
    assert.notEqual(read("apps/plain/gen/plain.ts", tree), plainText);
  });

  test("init gives a project the repository's guard on what the tools write", () => {
    const json = (root: string, file: string) => JSON.parse(read(file, root));
    const fresh = scratch({});
    init(fresh);
    const { permissions } = json(project, ".agents/claude-settings.json");
    assert.deepEqual(json(fresh, ".claude/settings.json"), { permissions: { ...permissions, deny: permissions.deny.filter((rule: string) => !rule.includes("/vibestack/")) } });
    const own = scratch({ ".claude/settings.json": "{}\n" });
    assert.ok(!init(own).includes(".claude/settings.json"));
    assert.equal(read(".claude/settings.json", own), "{}\n");
  });

  test("a simulation gives Quint's evaluator the compiled harness and reads the traces `quint run` writes for the same arguments, whether the rule holds or breaks", async () => {
    const { simulate } = await import("./simulate.ts");
    const root = oneRule("t", "Counting", `${COUNTER}\npure def sometimesFull(n: int): bool = n == 2`);
    const spec = readSpecs(root)[0];
    const model = await gen(root, spec);
    const harness = { memory: { root, fresh: true, used: new Set<string>() }, model, files: harnessFiles(spec, [spec], model) };
    const traces = (dir: string, prefix = "") => Object.fromEntries(fs.readdirSync(path.join(root, dir)).filter((f) => f.startsWith(prefix) && f.endsWith(".itf.json"))
      .map((f) => [f.slice(prefix.length), read(path.join(dir, f), root).replace(/"description":"[^"]*","timestamp":\d+/, "")]));
    for (const [invariant, step, broken] of [["inv", "probe", false], ["never_sometimesFull", "step", true]] as const) {
      const run = await simulate(harness, invariant, 30, 300, step);
      const dir = `gen/traces/t.${invariant}.${step}`;
      assert.equal(run.broken, broken, run.again);
      assert.deepEqual(["table.json", "t.run.qnt"].map((f) => fs.existsSync(path.join(root, dir, f))), [true, false], "the evaluator ran on the compiled harness");
      const args = run.again.split(" gen/t.run.qnt ")[1].split(" ");
      const cli = await exec(path.join(nodeModules, ".bin", process.platform === "win32" ? "quint.cmd" : "quint"), ["run", "t.run.qnt", ...args, "--n-traces", "30", "--out-itf", `${invariant}-{seq}.itf.json`], path.join(root, "gen"));
      assert.equal(cli.status, broken ? 1 : 0, cli.stderr);
      const written = traces(dir);
      assert.equal(Object.keys(written).length, 30, run.again);
      assert.deepEqual(written, traces("gen", `${invariant}-`), run.again);
    }
    for (const [said, text] of [[/Runtime error[^]*QNT503[^]*t\.run\.qnt:\d+/, model.harness.replace("val inv = ", "val inv = 1 / (0 * 1) == 0 and ")], [/QNT000[^]*t\.run\.qnt:\d+[^]*parsing failed/, `${model.harness}\nnonsense`]] as const) {
      const unanswered = { ...model, harness: text };
      await assert.rejects(simulate({ ...harness, model: unanswered, files: harnessFiles(spec, [spec], unanswered) }, "inv", 30, 300, "probe"), said);
      assert.ok(fs.existsSync(path.join(root, "gen/traces/t.inv.probe/t.run.qnt")), "`quint run` says why the evaluator gave no answer");
    }
  });

  test("a verifier retains the CPU used by a helper it has already waited for", { skip: process.platform !== "linux" && process.platform !== "darwin" }, async () => {
    const root = scratch({
      "helper.mjs": 'const start = process.cpuUsage();\nfor (;;) { const cpu = process.cpuUsage(start); if (cpu.user + cpu.system >= 300_000) break; }\n',
      "inherited.mjs": `import fs from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
while (!fs.existsSync("work")) await wait(20);
await import("./helper.mjs");
fs.writeFileSync("writer-work", "complete");
setInterval(() => {}, 60_000);`,
      "handoff.mjs": `import fs from "node:fs";
import { spawn } from "node:child_process";
const writer = spawn(process.execPath, ["inherited.mjs"], { stdio: ["ignore", process.stdout, process.stderr] });
writer.once("spawn", () => { fs.writeFileSync("writer.pid", String(writer.pid)); process.exit(0); });`,
      "accounting-run.ts": read("vibestack/run.ts"),
      "accounting-hold.mjs": 'process.send("ready");\nsetInterval(() => {}, 60_000);\n',
      "ps": `#!${process.execPath}
import fs from "node:fs";
import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["accounting-hold.mjs"], { cwd: import.meta.dirname, stdio: ["ignore", process.stdout, process.stderr, "ipc"] });
child.once("spawn", () => fs.writeFileSync(process.env.ACCOUNTING_MARKER, JSON.stringify([process.pid, child.pid])));
child.once("message", () => {
  fs.writeFileSync(process.env.ACCOUNTING_MARKER + ".ready", "");
  if (process.env.ACCOUNTING_PARENT === "exited") process.exit(0);
});
`,
      "accounting-abort.mjs": `import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { toolCpuSeconds } from "./accounting-run.ts";
const turn = () => new Promise(resolve => setImmediate(resolve));
const running = pid => {
  const row = spawnSync("/bin/ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  return row.status === 0 && row.stdout.trim() !== "" && !row.stdout.trim().startsWith("Z");
};
const until = async ready => {
  const deadline = performance.now() + 30_000;
  while (!ready()) { assert.ok(performance.now() < deadline, "accounting helper did not reach its process boundary"); await turn(); }
};
fs.chmodSync("ps", 0o755);
process.env.PATH = import.meta.dirname + path.delimiter + process.env.PATH;
for (const mode of ["alive", "exited"]) {
  process.env.ACCOUNTING_PARENT = mode;
  const marker = path.join(import.meta.dirname, "accounting-" + mode);
  process.env.ACCOUNTING_MARKER = marker;
  const verifier = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], { stdio: "ignore" });
  const closed = once(verifier, "close");
  const controller = new AbortController();
  let settled = false, helpers = [];
  const sampling = toolCpuSeconds([verifier], controller.signal).then(value => { settled = true; return value; });
  try {
    await until(() => fs.existsSync(marker + ".ready"));
    helpers = JSON.parse(fs.readFileSync(marker, "utf8"));
    if (mode === "exited") await until(() => !running(helpers[0]));
    else assert.ok(running(helpers[0]), "the accounting parent is still alive");
    assert.ok(running(helpers[1]), "the accounting descendant holds the inherited output");
    controller.abort();
    await turn();
    assert.ok(settled, mode + ": abort releases accounting without waiting for inherited output to close");
    await until(() => helpers.every(pid => !running(pid)));
  } finally {
    controller.abort();
    if (!helpers.length && fs.existsSync(marker)) helpers = JSON.parse(fs.readFileSync(marker, "utf8"));
    for (const pid of [...helpers, verifier.pid]) { try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
    await Promise.all([closed, sampling]);
    await until(() => helpers.every(pid => !running(pid)));
  }
}
`,
      "verifier.mjs": 'import { spawnSync } from "node:child_process";\nprocess.on("message", () => { const child = spawnSync(process.execPath, ["helper.mjs"]); process.send(child.status); });\nprocess.send("ready");\n',
    });
    const verifier = spawn(process.execPath, ["verifier.mjs"], { cwd: root, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const closed = once(verifier, "close");
    try {
      await once(verifier, "message");
      const [before] = await toolCpuSeconds([verifier]);
      const reaped = once(verifier, "message");
      verifier.send("work");
      assert.equal((await reaped)[0], 0);
      const [after] = await toolCpuSeconds([verifier]);
      assert.ok(before?.complete && after?.complete && after.seconds - before.seconds >= 0.28, `CPU seconds before ${before?.seconds}, after ${after?.seconds}`);
    } finally {
      verifier.kill();
      await closed;
    }
    const leader = spawn(process.execPath, ["handoff.mjs"], { cwd: root, detached: true, stdio: ["ignore", "pipe", "inherit"] });
    const outputClosed = once(leader, "close");
    await once(leader, "exit");
    const writer = Number(read("writer.pid", root));
    try {
      const [before] = await toolCpuSeconds([leader]);
      fs.writeFileSync(path.join(root, "work"), "");
      await until(() => fs.existsSync(path.join(root, "writer-work")));
      const [after] = await toolCpuSeconds([leader]);
      assert.ok(before && !before.complete && after && !after.complete);
      assert.ok(after.seconds - before.seconds >= 0.28, "the surviving writer continued to use CPU");
    } finally {
      process.kill(writer, "SIGKILL");
      await outputClosed;
    }
    const aborted = await exec(process.execPath, ["accounting-abort.mjs"], root);
    assert.equal(aborted.status, 0, aborted.stderr);
  });

  test("a check that is interrupted, or that exits, ends each tool it started and what the tool started, in its process group or out of it, as it ends a tool that writes too much", { skip: process.platform === "win32" }, async () => {
    const root = scratch({
      "short-watchdog.ts": read("vibestack/run.ts")
        .replace(/^const WATCH = .*;$/m, "const WATCH = 100;")
        .replace(/^const SLOTS = .*;$/m, "const SLOTS = 2;"),
      "inherited-output.mjs": `import { spawn } from "node:child_process";
const mode = process.argv[2];
const helper = spawn(process.execPath, ["hold-output.mjs", mode, String(process.pid)], {
  stdio: ["ignore", process.stdout, process.stderr], detached: mode === "detached",
});
helper.once("spawn", () => process.exit(0));
`,
      "hold-output.mjs": `import fs from "node:fs";
const [mode, parent] = process.argv.slice(2);
const marker = "helper-" + mode;
fs.writeFileSync(marker + ".tmp", JSON.stringify([Number(parent), process.pid]));
fs.renameSync(marker + ".tmp", marker);
setTimeout(() => fs.writeFileSync("finished-" + mode, "done"), 60_000);
`,
      "watchdog-check.mjs": `import assert from "node:assert/strict";
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { exec } from "./short-watchdog.ts";
const modes = ["same-group", "detached"];
const helper = (mode) => fs.existsSync("helper-" + mode) ? JSON.parse(fs.readFileSync("helper-" + mode, "utf8")) : undefined;
const running = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code !== "ESRCH") throw error; return false; }
};
const ready = () => modes.every(mode => { const pids = helper(mode); return pids && !running(pids[0]) && running(pids[1]); });
const originalNow = Date.now;
const finished = Promise.all(modes.map(mode => exec(process.execPath, ["inherited-output.mjs", mode], import.meta.dirname)));
try {
  const deadline = performance.now() + 30_000;
  while (!ready() && performance.now() < deadline) await delay(50);
  assert.ok(ready(), "both writers started and their parents were reaped");
  const clockStart = performance.now();
  Date.now = () => originalNow() + 61 * 60_000 + Math.floor((performance.now() - clockStart) * 10_000);
  const results = await Promise.race([finished, delay(20_000, undefined, { ref: false })]);
  assert.ok(results, "the watchdog released both inherited pipes");
  for (const [index, mode] of modes.entries()) {
    assert.ok(results[index].stopped, mode + ": the watchdog ended the command");
    assert.ok(!fs.existsSync("finished-" + mode), mode + ": the command returned while its inherited pipe was still held");
  }
} finally {
  Date.now = originalNow;
  for (const mode of modes) {
    const pids = helper(mode);
    if (!pids || fs.existsSync("finished-" + mode)) continue;
    try { process.kill(pids[1], "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}
`,
      "tool.mjs": 'import { spawn } from "node:child_process";\nimport fs from "node:fs";\nconst started = [false, true].map((detached) => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached }).pid);\nfs.writeFileSync(process.argv[2], `${process.pid} ${started.join(" ")} `);\nsetInterval(() => {}, 1000);\nconst flood = () => { while (process.stdout.write("x".repeat(1 << 20))); process.stdout.once("drain", flood); };\nif (process.argv[3]) flood();\n',
      "cancel-check.mjs": `import assert from "node:assert/strict";
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { exec } from "./short-watchdog.ts";
const proof = new AbortController();
const run = (args, signal) => exec(process.execPath, args, import.meta.dirname, undefined, undefined, signal);
const alive = (pid) => { try { return process.kill(pid, 0); } catch (error) { if (error.code !== "ESRCH") throw error; return false; } };
const until = async (ready) => {
  const deadline = performance.now() + 15_000;
  while (!ready() && performance.now() < deadline) await delay(25);
  assert.ok(ready());
};
const completed = await run(["-e", "process.stdout.write('completed')"], proof.signal);
const active = run(["tool.mjs", "proof"], proof.signal);
const other = run(["-e", "const fs = require('node:fs'); fs.writeFileSync('other-ready', ''); setInterval(() => { if (fs.existsSync('other-release')) process.exit(0); }, 20)"]);
const queued = run(["-e", "require('node:fs').writeFileSync('queued-proof', '')"], proof.signal);
const following = run(["-e", "process.stdout.write('following')"]);
try {
  await until(() => fs.existsSync("other-ready") && fs.existsSync("proof") && fs.readFileSync("proof", "utf8").endsWith(" "));
  const pids = fs.readFileSync("proof", "utf8").trim().split(" ").map(Number);
  assert.ok(pids.every(alive));
  proof.abort();
  const [runningResult, queuedResult] = await Promise.all([active, queued]);
  assert.ok(runningResult.stopped && queuedResult.stopped);
  await until(() => pids.every((pid) => !alive(pid)));
  assert.ok(!fs.existsSync("queued-proof"));
  assert.equal(completed.stdout, "completed");
  assert.equal(completed.stopped, undefined);
  assert.equal((await following).stdout, "following");
} finally {
  proof.abort();
  fs.writeFileSync("other-release", "");
}
assert.equal((await other).status, 0);
`,
      "check.mjs": `import { exec } from ${JSON.stringify(path.join(project, "vibestack/run.ts"))};\nvoid exec(process.execPath, ["tool.mjs", process.argv[2]], import.meta.dirname);\nprocess.stdin.once("data", () => process.exit(3));\n`,
    });
    const running = (pid: number) => { try { return process.kill(pid, 0); } catch { return false; } };
    const flooded = await exec(process.execPath, ["tool.mjs", "flood", "stdout"], root);
    assert.match(flooded.stopped ?? "", /^node wrote more than \d+ MB of output and was stopped$/);
    const flooding = read("flood", root).trim().split(" ").map(Number);
    await until(() => !flooding.some(running), () => `a tool stopped for its output left ${flooding.filter(running).join(" and ")} running`);
    const inherited = await exec(process.execPath, ["watchdog-check.mjs"], root);
    assert.equal(inherited.status, 0, inherited.stdout + inherited.stderr);
    const canceled = await exec(process.execPath, ["cancel-check.mjs"], root);
    assert.equal(canceled.status, 0, canceled.stdout + canceled.stderr);
    for (const how of ["SIGTERM", "SIGINT", "SIGHUP", "exit"] as const) {
      const checking = spawn(process.execPath, ["check.mjs", how], { cwd: root, stdio: ["pipe", "ignore", "inherit"] });
      const ended = new Promise((resolve) => checking.once("close", (code, signal) => resolve(signal ?? code)));
      const pids = () => (fs.existsSync(path.join(root, how)) ? read(how, root) : "").split(" ");
      await until(() => pids().length === 4);
      const tools = pids().slice(0, 3).map(Number);
      assert.deepEqual(tools.map(running), [true, true, true]);
      if (how === "exit") checking.stdin.write("exit");
      else checking.kill(how);
      assert.equal(await ended, how === "exit" ? 3 : how);
      await until(() => !tools.some(running), () => `${how} left ${tools.filter(running).join(" and ")} running`);
    }
  });
}

const LANES = Math.min(4, os.availableParallelism());
const SHARDS = { [toolShards.a]: eachCheckA, [toolShards.b]: eachCheckB };
describe("the tools", { concurrency: true }, () => {
  describe("the command line and what a failed proof leaves to start from", { concurrency: LANES }, theCommandLine);
  describe("each check catches its own kind of mistake", { concurrency: LANES }, eachCheck);
});

test("the same installed Quint shares verification results across checkouts and distinct launchers and patches keep their own", { skip: process.platform === "win32" }, async () => {
  const install = (patch: string, fallback?: string) => {
    const root = toolchain(scratch({}));
    const modules = path.join(root, "node_modules");
    const store = path.join(modules, ".pnpm");
    const locator = `@informalsystems+quint@1.0.0_patch_hash=${patch}/node_modules`;
    const dir = path.join(store, locator, "@informalsystems/quint");
    fs.unlinkSync(store);
    fs.unlinkSync(path.join(modules, "@informalsystems"));
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(path.dirname(dir), path.join(modules, "@informalsystems"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@informalsystems/quint", version: "1.0.0", bin: "cli.cjs", description: patch, dependencies: { values: "1.0.0" } }));
    fs.writeFileSync(path.join(dir, "cli.cjs"), 'require("node:fs").writeFileSync("ir.json", JSON.stringify(require("values")));\n');
    const lookup = fallback ? "secondary/node_modules" : locator;
    const values = path.join(store, lookup, "values");
    fs.mkdirSync(values, { recursive: true });
    fs.writeFileSync(path.join(values, "package.json"), JSON.stringify({ name: "values", version: "1.0.0" }));
    fs.writeFileSync(path.join(values, "index.js"), `module.exports = ${JSON.stringify(fallback ?? "default")};\n`);
    const shim = path.join(modules, ".bin/quint");
    const stock = fs.readFileSync(path.join(nodeModules, ".bin/quint"), "utf8");
    const search = `${store}/${lookup}:${store}/node_modules`;
    fs.writeFileSync(shim, stock.replace(/^(  export NODE_PATH=")[^"\r]*("\r?)$/gm, (_line, before: string, after: string) => `${before}${search}:${before.includes("export") ? "$NODE_PATH" : ""}${after}`)
      .replace(/("\$basedir\/)[^"\r\n]+(" "\$@")/g, `$1../.pnpm/${locator}/@informalsystems/quint/cli.cjs$2`), { mode: 0o755 });
    return { root, shim, values };
  };
  const identity = async (root: string) => {
    const { installedProgram }: { installedProgram: typeof lookupTool } = await import(path.join(root, "vibestack/cache.ts"));
    const program = installedProgram(root, "quint");
    assert.ok(program);
    return program.id;
  };
  const left = install("first");
  const right = install("first");
  const expected = await identity(left.root);
  assert.ok(expected, "a recognized pnpm launcher supplies a reusable identity");
  assert.equal(await identity(right.root), expected);
  assert.notEqual(await identity(install("second").root), expected);
  const launcher = fs.readFileSync(right.shim, "utf8");
  for (const changed of [launcher.replace("exec node", "exec node --no-warnings"), launcher.replace("/node_modules:$NODE_PATH", "/another-module-path:$NODE_PATH")]) {
    fs.writeFileSync(right.shim, changed);
    assert.notEqual(await identity(right.root), expected);
  }
  for (const flag of ["NODE_PRESERVE_SYMLINKS", "NODE_PRESERVE_SYMLINKS_MAIN"]) {
    const project = install("first");
    const directory = path.join(project.root, "node_modules/@informalsystems/quint");
    const main = path.join(directory, "cli.cjs");
    if (flag === "NODE_PRESERVE_SYMLINKS") {
      const manifestFile = path.join(directory, "package.json");
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, dependencies: { left: "1.0.0", right: "1.0.0" } }));
      for (const name of ["left", "right"]) fs.symlinkSync("values", path.join(path.dirname(project.values), name), "dir");
      fs.writeFileSync(path.join(project.values, "index.js"), "module.exports = {};");
      fs.writeFileSync(main, 'require("node:fs").writeFileSync("ir.json", JSON.stringify(require("left") === require("right")));');
    } else {
      fs.mkdirSync(path.join(directory, "code"));
      fs.writeFileSync(path.join(directory, "code/cli.cjs"), 'require("node:fs").writeFileSync("ir.json", JSON.stringify(require("./local.cjs")));');
      fs.writeFileSync(path.join(directory, "code/local.cjs"), 'module.exports = "resolved-main";');
      fs.writeFileSync(path.join(directory, "local.cjs"), 'module.exports = "preserved-main";');
      fs.unlinkSync(main);
      fs.symlinkSync("code/cli.cjs", main);
    }
    const receipts = scratch({});
    const freshReceipts = scratch({});
    const child = await exec(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import { act } from "./vibestack/action.ts";
      import { installedProgram, steady, withFormalCache } from "./vibestack/cache.ts";
      const program = installedProgram(".", "quint");
      assert.ok(program.id);
      const run = async cache => JSON.parse((await withFormalCache(cache, () => steady(() => act({ root: ".", fresh: false, used: new Set() }, "quint", ["typecheck"], "run", {})))).files["ir.json"]);
      assert.equal(await run(${JSON.stringify(receipts)}), ${flag === "NODE_PRESERVE_SYMLINKS" ? 'true' : '"resolved-main"'});
      process.env[${JSON.stringify(flag)}] = "1";
      assert.equal(program.unchanged(), false);
      assert.equal(installedProgram(".", "quint").id, undefined);
      assert.deepEqual([await run(${JSON.stringify(receipts)}), await run(${JSON.stringify(freshReceipts)})], ${JSON.stringify(flag === "NODE_PRESERVE_SYMLINKS" ? [false, false] : ["preserved-main", "preserved-main"])});
    `], project.root);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(toolRuns(receipts).length, 1);
    assert.deepEqual(toolRuns(freshReceipts), []);
  }
  const malformed = install("first");
  const malformedManifest = path.join(malformed.root, "node_modules/@informalsystems/quint/package.json");
  const manifest = JSON.parse(fs.readFileSync(malformedManifest, "utf8"));
  for (const dependency of ["../escape", "/absolute", "@scope/../escape"]) {
    fs.writeFileSync(malformedManifest, JSON.stringify({ ...manifest, dependencies: { [dependency]: "1.0.0" } }));
    await assert.rejects(identity(malformed.root), /invalid package dependency/);
  }
  fs.writeFileSync(malformedManifest, JSON.stringify({ ...manifest, bin: "../escape.cjs" }));
  assert.equal(await identity(malformed.root), undefined);
  const mainVersion = install("first");
  const loadedVersion = install("second");
  for (const [project, value] of [[mainVersion, "main"], [loadedVersion, "loaded"]] as const) {
    const directory = path.join(project.root, "node_modules/@informalsystems/quint");
    fs.writeFileSync(path.join(directory, "identity.cjs"), `module.exports = ${JSON.stringify(value)};`);
    fs.writeFileSync(path.join(directory, "cli.cjs"), 'require("node:fs").writeFileSync("ir.json", JSON.stringify(require("@informalsystems/quint/identity.cjs")));');
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    if (value === "loaded") manifest.version = "2.0.0";
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest));
  }
  fs.unlinkSync(loadedVersion.shim);
  fs.writeFileSync(path.join(loadedVersion.root, "vibestack/simulator.ts"), `
import fs from "node:fs";
import { createRequire } from "node:module";
export const SIMULATOR = import.meta.filename;
export const TABLE = "table.json";
if (import.meta.main) fs.writeFileSync(TABLE, JSON.stringify(createRequire(import.meta.url)("@informalsystems/quint/identity.cjs")));
`);
  const roles = await exec(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { act } from ${JSON.stringify(path.join(loadedVersion.root, "vibestack/action.ts"))};
    import { installedProgram } from ${JSON.stringify(path.join(loadedVersion.root, "vibestack/cache.ts"))};
    assert.equal(installedProgram(${JSON.stringify(mainVersion.root)}, "quint").exe, ${JSON.stringify(mainVersion.shim)});
    assert.ok(installedProgram(${JSON.stringify(mainVersion.root)}, "quint").id);
    const memory = { root: ${JSON.stringify(mainVersion.root)}, fresh: false, used: new Set() };
    const cli = await act(memory, "quint", ["typecheck"], "cli", {});
    const simulator = await act(memory, "simulator", ["compile"], "simulator", {});
    assert.deepEqual([JSON.parse(cli.files["ir.json"]), JSON.parse(simulator.files["table.json"])], ["main", "loaded"]);
  `], mainVersion.root);
  assert.equal(roles.status, 0, roles.stderr);
  for (const kind of ["source", "node-options", "require"] as const) {
    const changed = install("first");
    const external = path.join(changed.root, kind === "source" ? "external.sh" : "external.cjs");
    const stock = fs.readFileSync(changed.shim, "utf8");
    const directive = kind === "source" ? `. ${JSON.stringify(external)}` : `export NODE_OPTIONS="--require ${external}"`;
    const launcher = kind === "require" ? stock.replace(/^(  exec (?:node|"\$basedir\/node"))  /gm, `$1 --require ${JSON.stringify(external)} `)
      : stock.replace("#!/bin/sh\n", `#!/bin/sh\n${directive}\n`);
    fs.writeFileSync(changed.shim, launcher);
    fs.writeFileSync(path.join(changed.root, "node_modules/@informalsystems/quint/cli.cjs"), 'require("node:fs").writeFileSync("ir.json", JSON.stringify(process.env.EXTERNAL_VALUE));\n');
    const cache = scratch({});
    for (const value of ["before", "after"]) {
      fs.writeFileSync(external, kind === "source" ? `export EXTERNAL_VALUE=${value}\n` : `process.env.EXTERNAL_VALUE = ${JSON.stringify(value)};\n`);
      const child = await exec(process.execPath, ["--input-type=module", "--eval", `
        import assert from "node:assert/strict";
        import { act } from "./vibestack/action.ts";
        import { installedProgram, withFormalCache } from "./vibestack/cache.ts";
        assert.equal(installedProgram(".", "quint").id, undefined);
        const result = await withFormalCache(${JSON.stringify(cache)}, () => act({ root: ".", fresh: false, used: new Set() }, "quint", ["typecheck"], "run", {}));
        console.log(result.files["ir.json"]);
      `], changed.root);
      assert.equal(child.status, 0, child.stderr);
      assert.equal(JSON.parse(child.stdout), value);
    }
    assert.deepEqual(toolRuns(cache), [], `${kind} external code always executes afresh`);
  }
  const changedInterpreter = install("first");
  const alternateNode = path.join(changedInterpreter.root, "node_modules/.bin/node");
  const alternateCache = scratch({});
  for (const value of ["alternate", "revised"]) {
    fs.writeFileSync(alternateNode, `#!/bin/sh\n${JSON.stringify(process.execPath)} -e 'require("node:fs").writeFileSync("ir.json", JSON.stringify(${JSON.stringify(value)}))'\n`, { mode: 0o755 });
    const child = await exec(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import { act } from "./vibestack/action.ts";
      import { installedProgram, withFormalCache } from "./vibestack/cache.ts";
      assert.equal(installedProgram(".", "quint").id, undefined);
      const result = await withFormalCache(${JSON.stringify(alternateCache)}, () => act({ root: ".", fresh: false, used: new Set() }, "quint", ["typecheck"], "run", {}));
      console.log(result.files["ir.json"]);
    `], changedInterpreter.root);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout), value);
  }
  assert.deepEqual(toolRuns(alternateCache), [], "a different selected Node cannot reuse a receipt");
  const shared = scratch({});
  for (const [value, bareFile] of [["first", false], ["second", false], ["third", true]] as const) {
    const { root } = install("first");
    const hoisted = path.join(root, "node_modules/.pnpm/node_modules");
    fs.mkdirSync(hoisted);
    const marker = path.join(hoisted, "marker");
    if (!bareFile) {
      fs.mkdirSync(marker);
      fs.writeFileSync(path.join(marker, "package.json"), '{"name":"marker","version":"1.0.0"}');
    }
    fs.writeFileSync(bareFile ? `${marker}.js` : path.join(marker, "index.js"), `module.exports = ${JSON.stringify(value)};\n`);
    fs.writeFileSync(path.join(root, "node_modules/@informalsystems/quint/cli.cjs"), 'let value; try { value = require("marker"); } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; value = "isolated"; } require("node:fs").writeFileSync("ir.json", JSON.stringify(value));\n');
    const ordinary = await exec(path.join(root, "node_modules/.bin/quint"), ["typecheck"], root);
    assert.equal(ordinary.status, 0, ordinary.stderr);
    assert.equal(JSON.parse(read("ir.json", root)), value);
    const child = await exec(process.execPath, ["--input-type=module", "--eval", `
      import { act } from "./vibestack/action.ts";
      import { withFormalCache } from "./vibestack/cache.ts";
      const result = await withFormalCache(${JSON.stringify(shared)}, () => act({ root: ".", fresh: false, used: new Set() }, "quint", ["typecheck"], "run", {}));
      console.log(result.files["ir.json"]);
    `], root);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout), "isolated");
  }
  assert.equal(toolRuns(shared).length, 1);
  const transient = install("first");
  const implementation = path.join(transient.root, "node_modules/@informalsystems/quint/cli.cjs");
  fs.writeFileSync(implementation, `const fs = require("node:fs");
const original = fs.readFileSync(__filename);
try {
  fs.writeFileSync(__filename, 'require("node:fs").writeFileSync("ir.json", JSON.stringify("transient"));');
  require("node:child_process").execFileSync(process.execPath, [__filename]);
} finally {
  fs.writeFileSync(__filename, original);
}
`);
  const changedDuringRun = await exec(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import { act } from "./vibestack/action.ts";
    import { steady } from "./vibestack/cache.ts";
    const file = "node_modules/@informalsystems/quint/cli.cjs";
    const original = fs.readFileSync(file);
    await assert.rejects(steady(() => act({ root: ".", fresh: false, used: new Set() }, "quint", ["typecheck"], "run", {})), /tool installation changed/);
    assert.equal(JSON.parse(fs.readFileSync("run/ir.json", "utf8")), "transient");
    assert.deepEqual(fs.readFileSync(file), original);
  `], transient.root);
  assert.equal(changedDuringRun.status, 0, changedDuringRun.stderr);
  assert.deepEqual(toolRuns(path.join(transient.root, ".spec-cache")), [], "a changed implementation executed then restored cannot publish");
  const publication = await exec(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import { entry, installedProgram, recall, steady, store } from "./vibestack/cache.ts";
    const memory = { root: ".", fresh: false, used: new Set() };
    const [first, next, tainted] = await Promise.all(["first", "next", "tainted"].map(key => entry(".", "action", [key])));
    const aggregate = await entry(".", "types", ["together"]);
    const program = installedProgram(".", "quint");
    const write = to => store(memory, to, to.name, { program, began: performance.now() });
    await steady(async () => {
      write(first);
      assert.ok(fs.existsSync(first.file), "the first completed action survives interruption");
      write(next);
      assert.equal(recall(memory, next), next.name, "the check can use its own completed action");
      store(memory, aggregate, [first.name, next.name]);
      assert.ok([first, next, aggregate].every(item => fs.existsSync(item.file)), "a stage publishes its verified actions");
    });
    await assert.rejects(steady(async () => {
      write(first);
      const source = "node_modules/@informalsystems/quint/cli.cjs";
      const original = fs.readFileSync(source);
      fs.appendFileSync(source, "export const changed = true;");
      fs.writeFileSync(source, original);
      write(tainted);
    }), /tool installation changed/);
    assert.equal(fs.existsSync(tainted.file), false, "an edit and restore cannot publish a stale action");
    assert.equal(recall(memory, first), first.name, "the prior verified action survives");
    await assert.rejects(steady(async () => {
      installedProgram(".", "quint");
      assert.equal(recall(memory, first), first.name);
      fs.appendFileSync("node_modules/@informalsystems/quint/cli.cjs", " ");
    }), /tool installation changed/);
  `], left.root);
  assert.equal(publication.status, 0, publication.stderr);
  const results = [];
  for (const selection of ["left", "right"]) {
    const project = install("first", selection);
    const child = await exec(process.execPath, ["--input-type=module", "--eval", `
      import fs from "node:fs";
      import { act } from "./vibestack/action.ts";
      const run = async () => (await act({ root: ".", fresh: false, used: new Set() }, "quint", ["typecheck"], "run", {})).files["ir.json"];
      const first = await run();
      fs.writeFileSync(${JSON.stringify(path.join(project.values, "index.js"))}, 'module.exports = "revised";');
      console.log(JSON.stringify([first, await run()]));
    `], project.root);
    assert.equal(child.status, 0, child.stderr);
    results.push([...JSON.parse(child.stdout), toolRuns(path.join(project.root, ".spec-cache"))]);
  }
  assert.deepEqual(results, [['"left"', '"revised"', []], ['"right"', '"revised"', []]]);
  const hosted = install("first");
  const store = path.join(hosted.root, "node_modules/.pnpm");
  const modules = path.join(store, "runner@1/node_modules");
  const runner = path.join(modules, "runner");
  fs.mkdirSync(runner, { recursive: true });
  fs.writeFileSync(path.join(runner, "package.json"), '{"name":"runner","version":"1.0.0"}');
  const provided = path.join(modules, "values");
  fs.renameSync(hosted.values, provided);
  const checked = await exec(process.execPath, ["--input-type=module", "--eval", `
    import fs from "node:fs";
    import { act } from "./vibestack/action.ts";
    const run = async () => (await act({ root: ".", fresh: false, used: new Set() }, "quint", ["typecheck"], "run", {})).files["ir.json"];
    const values = [await run(), await run()];
    fs.writeFileSync(${JSON.stringify(path.join(provided, "index.js"))}, 'module.exports = "from host";');
    console.log(JSON.stringify([...values, await run()]));
  `], hosted.root, { ...process.env, NODE_PATH: [path.join(runner, "node_modules"), modules, path.join(store, "node_modules")].join(path.delimiter) });
  assert.equal(checked.status, 0, checked.stderr);
  assert.deepEqual([JSON.parse(checked.stdout), toolRuns(path.join(hosted.root, ".spec-cache")).length], [['"default"', '"default"', '"from host"'], 0]);

});

test("check phase timings end a simulation before later definitions finish generating", { skip: process.platform === "win32" }, async () => {
  const root = toolchain(scratch({
    "spec/counter.md": ruleSpec("pure val initial: int = 0\npure def bump(n: int): int = n + 1\npure def alwaysPositive(n: int): bool = n > 0"),
    "spec/definitions.md": ruleSpec("pure val answer: int = 42"),
  }));
  stockQuint(root, `if (process.argv[2] === "typecheck" && process.argv[5] === "definitions.qnt") {
    const fs = require("node:fs");
    const marker = ${JSON.stringify(path.join(root, "simulation-finished"))};
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const deadline = performance.now() + 60_000;
    while (!fs.existsSync(marker) && performance.now() < deadline) Atomics.wait(signal, 0, 0, 20);
    if (!fs.existsSync(marker)) throw new Error("no simulation result was saved");
    Atomics.wait(signal, 0, 0, 300);
  }`);
  const child = await exec(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { channel } from "node:diagnostics_channel";
    import fs from "node:fs";
    import path from "node:path";
    import { check } from "./vibestack/pipeline.ts";
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      rename(from, to);
      if (/^simulate-.*\\.json\\./.test(path.basename(to))) fs.writeFileSync("simulation-finished", "");
    };
    const events = [];
    channel("vibestack:check:phase").subscribe(event => events.push(event));
    const result = await check(process.cwd());
    assert.ok(result.results.some(r => r.ok && r.stage === "model" && r.where === "spec/definitions.md" && r.summary.includes("definitions only")));
    assert.ok(result.results.some(r => !r.ok && r.stage === "always" && r.where === "spec/counter.md" && r.summary.includes("fix the model")), JSON.stringify(result.results));
    const time = (phase, event) => events.find(e => e.phase === phase && e.event === event).elapsedMs;
    assert.ok(time("simulation", "start") <= time("simulation", "end"));
    assert.ok(time("generation", "end") - time("simulation", "end") >= 200, JSON.stringify(events));
    events.length = 0;
    const interrupted = new Error("ordinary generation failure");
    await assert.rejects(check(process.cwd(), false, () => { throw interrupted; }), error => error === interrupted);
    assert.deepEqual(events.map(({ phase, event }) => [phase, event]), [["generation", "start"], ["generation", "end"]]);
  `], root);
  assert.equal(child.status, 0, child.stdout + child.stderr);
});

test("a trace integer of 16 or more digits that Quint wrote as a BigNumber decodes to the same integer", () => {
  const n = (x: number | string) => ({ "#bigint": String(x) });
  // What quint 0.33.1 writes for the integer 10^15.
  assert.equal(bigNumberInteger({ s: n(1), e: n(15), c: [n(10)] }), 10n ** 15n);
  assert.equal(bigNumberInteger({ s: n(-1), e: n(19), c: [n(123456), n(78901234560000)] }), -12345678901234560000n);
  assert.equal(bigNumberInteger({ s: n(1), e: n(29), c: [n(10), n(0), n(1)] }), 10n ** 29n + 1n);
  assert.equal(bigNumberInteger({ s: n(1), e: n(0), c: [n(15)] }), undefined, "1.5 is not an integer");
  assert.equal(bigNumberInteger({ s: n(1), e: n(15), c: [n(10)], d: n(0) }), undefined, "a record with other fields is not a BigNumber");
});

test("the lint refuses, in a project's own code, a comment that is neither a citation nor a tool directive, an effect hook, a timer, a console call, inline config that would hide one, and one more than a listed file keeps", async () => {
  const { ESLint } = await import("eslint");
  const eslint = new ESLint({ cwd: project });
  const found = async (file: string, lines: string[]) => (await eslint.lintText(lines.join("\n"), { filePath: path.join(project, file) }))[0]!.messages
    .filter((m) => m.fatal || m.ruleId === "no-console" || m.ruleId?.startsWith("code/")).map((m) => `${m.line} ${m.ruleId ?? "inline config"}`);
  const spec = readSpecs(project).find((s) => s.file.startsWith("spec/")
    && s.stories.some((story) => !story.title.includes('"'))
    && s.rules.some((rule) => !heading(rule).includes('"')));
  const specFile = spec?.file ?? "spec/app/index.md";
  const storyHeading = spec?.stories.find((story) => !story.title.includes('"'))?.title ?? "Story: Say hello";
  const ruleHeading = spec ? heading(spec.rules.find((rule) => !heading(rule).includes('"'))!) : "The number of greetings is never negative";
  assert.deepEqual(await found("apps/app/src/probe.vibe", [
    `// ${specFile}, "${storyHeading}"; ${specFile}, "${ruleHeading}"`,
    `/* ${specFile}, "${storyHeading}" */`,
    "//@ ghost",
    `/** @model ${specFile} */`,
    "/** @throws {never} */",
    "// a note",
    "/** What it is. */",
    "/** What it does. @throws {Error} */",
    "//@ pure-ish",
    "useEffect(() => {}, []);",
    "window.setTimeout(() => {}, 1);",
    "requestAnimationFrame(() => {});",
    `console.log("seen");`,
    "const later = React.useLayoutEffect;",
    `globalThis["queueMicrotask"](later);`,
    "// eslint-disable-next-line no-undef -- a global the page defines",
  ]), ["6 code/comments", "7 code/comments", "8 code/comments", "9 code/comments", "10 code/effects", "11 code/effects", "12 code/effects", "13 no-console", "14 code/effects", "15 code/effects"]);
  assert.deepEqual([...new Set(await found("apps/app/src/probe.vibe", [
    "const clock = { setTimeout: () => undefined }",
    "const capture = { setTimeout: globalThis.setTimeout }",
    "const { setTimeout: schedule } = globalThis",
    'const computed = globalThis["setTimeout"]',
    "const shorthand = { setTimeout }",
  ]))], ["2 code/effects", "3 code/effects", "4 code/effects", "5 code/effects"]);
  assert.deepEqual(await found("apps/app/src/probe.vibe", [
    "module bridge {",
    "  /**",
    "   * @throws {Error | TypeError}",
    "   */",
    "  export function read() { throw new Error() }",
    "  /** @throws {This is ordinary prose} */",
    "  export function readProse() {}",
    "  /** @throws {never",
    "   * Ordinary prose on another line} */",
    "  export function readMultilineProse() {}",
    "  /** @throws {} */",
    "  export function readEmpty() {}",
    "  /** @throws { } */",
    "  export function readWhitespace() {}",
    "}",
  ]), ["6 code/comments", "8 code/comments", "11 code/comments", "13 code/comments"]);
  const hiding = [["useEffect(() => {}, []); // eslint-disable-line"], ["/* eslint-disable */", "// a note"], ["/* eslint-disable code/comments, code/effects -- it must */", "setTimeout(() => {}, 1);"], ["/* eslint code/comments: off, no-console: off */", `console.log("seen");`], ["// eslint-disable-next-line no-console -- it must", `console.log("seen");`]];
  assert.deepEqual(await Promise.all(hiding.map((lines) => found("apps/app/src/probe.vibe", lines))), hiding.map(() => ["1 inline config"]));
  assert.deepEqual(await found("packages/ui/src/components/probe.vibe", ["/** What a component takes, which the stories generator reads. */", "export function Probe() {", "  /** inside it */", "  return 1;", "}", "// a note"]), ["3 code/comments", "6 code/comments"]);
  const consoleLines = (count: number) => Array.from({ length: count }, () => 'console.warn("seen");');
  const logger = "packages/core/src/logger.vibe";
  assert.deepEqual(await found(logger, consoleLines(3)), []);
  assert.deepEqual(await found(logger, consoleLines(4)), ["1 code/console", "2 code/console", "3 code/console", "4 code/console"]);
  const message = async (file: string) => (await eslint.lintText(consoleLines(4).join("\n"), { filePath: path.join(project, file) }))[0]!.messages
    .filter((m) => m.ruleId === "no-console" || m.ruleId === "code/console").map((m) => m.message);
  assert.deepEqual(await message(logger), await message("apps/app/src/probe.vibe"));
  const { default: config } = await import(path.join(project, "eslint.config.js"));
  const [file, left] = Object.entries(config.find((block: { rules?: Record<string, unknown> }) => block.rules?.["code/comments"]).rules["code/comments"][1].left as Record<string, number>).find(([file]) => file.endsWith(".vibe"))!;
  const notes = (n: number) => Array.from({ length: n }, () => "// a note");
  assert.deepEqual([(await found(file, notes(left))).length, (await found(file, notes(left + 1))).length], [0, left + 1]);
});

test("the barrel lint refuses non-barrel workspace exports, subpath imports, inline disables and stale ratchets", async (context) => {
  const { ESLint } = await import("eslint");
  const { default: js } = await import("@eslint/js");
  const { defineConfig, globalIgnores } = await import("eslint/config");
  const { default: tseslint } = await import("typescript-eslint");
  const { default: vibelang } = await import("vibelang/eslint");
  const { withWorkspaceBarrels } = await import("./eslint.ts");

  const barrelHits = async (eslint: InstanceType<typeof ESLint>, file: string, lines: readonly string[], cwd = project) => {
    const [res] = await eslint.lintText(lines.join("\n"), { filePath: path.join(cwd, file) });
    return res!.messages
      .filter((m) => m.fatal || m.ruleId?.startsWith("barrel/"))
      .map((m) => `${m.line}:${m.column} ${m.ruleId ?? "fatal"} ${m.message}`);
  };

  const live = new ESLint({ cwd: project });
  const allowedImports = [
    'import { Button } from "@repo/ui";',
    'import "@repo/ui/styles.css";',
    'import "@repo/ui/styles.css?inline";',
    'import tokens from "@repo/design-system/tokens.json" with { type: "json" };',
    'void import.meta.resolve("@repo/design-system/tokens.json");',
    'import { project as p } from "vibestack/testing/vitest";',
    'import { Effect } from "effect";',
    'import { Schema } from "effect/Schema";',
    "// eslint-disable-next-line no-undef -- global",
    "void [Button, tokens, p, Effect, Schema];",
  ];
  assert.deepEqual(await barrelHits(live, "apps/app/src/probe.vibe", allowedImports), []);
  assert.deepEqual(await barrelHits(live, "vibestack/spec.ts", allowedImports), []);

  const appPkg = fs.existsSync(path.join(project, "apps/app/package.json")) ? JSON.parse(read("apps/app/package.json")).name as string : "@repo/design-system";
  const badImports = [
    'import { x } from "@repo/ui/client";',
    'import { b } from "@repo/ui/src/components/Button";',
    'export { x } from "@repo/ui/internal";',
    'export * from "@repo/ui/internal";',
    'void import("@repo/ui/client");',
    "void import(`@repo/ui/${name}`);",
    'void import("@repo/ui/" + name);',
    'require("@repo/ui/client");',
    'require.resolve("@repo/ui/client");',
    'import.meta.resolve("@repo/ui/client");',
    'type T = import("@repo/ui/client").Foo;',
    'import "@repo/ui/nonexistent.css";',
    'import "@repo/ui/a/../styles.css";',
    'import "@repo/ui/";',
    `import "${appPkg}/src/App";`,
    'import "vibestack-studio/src/project";',
  ];
  for (const target of ["apps/app/src/probe.vibe", "vibestack/spec.ts"]) {
    const got = await barrelHits(live, target, badImports);
    assert.equal(got.length, badImports.length, `${target}: ${got.join("\n")}`);
    assert.ok(got.every((line) => line.includes("barrel/no-subpath-imports")));
    assert.ok(got.some((line) => line.includes("not a declared static asset export")));
  }

  const bypasses = [
    ['// eslint-disable-next-line barrel/no-subpath-imports -- nope', 'import "@repo/ui/client";'],
    ["/* eslint-disable */", 'import "@repo/ui/client";'],
    ["/* eslint barrel/no-subpath-imports: off */", 'import "@repo/ui/client";'],
    ['import "@repo/ui/client"; // eslint-disable-line'],
  ];
  for (const target of ["apps/app/src/probe.vibe", "vibestack/spec.ts"]) {
    const results = await Promise.all(bypasses.map((lines) => barrelHits(live, target, lines)));
    assert.ok(results.every((msgs) => msgs.length === 1 && msgs[0]!.includes(" fatal ")), `${target}: ${JSON.stringify(results)}`);
  }

  for (const goodManifest of [
    '{ "name": "@repo/ui", "exports": { ".": "./src/index.ts", "./styles.css": "./styles.css", "./tokens.json": { "types": "./tokens.d.ts", "default": "./tokens.json" }, "./internal/*": null } }',
    '{ "name": "@repo/ui", "exports": "./src/index.ts" }',
    '{ "name": "@repo/ui", "exports": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }',
    '{ "name": "@repo/ui" }',
  ]) {
    assert.deepEqual(await barrelHits(live, "packages/ui/package.json", [goodManifest]), [], goodManifest);
  }

  for (const [badManifest, snippet] of [
    ['{ "name": "@repo/ui", "exports": { ".": "./src/index.ts", "./client": "./src/client.ts" } }', "barrel/exports"],
    ['{ "name": "@repo/ui", "exports": { ".": "./src/index.ts", "./bridges/*": "./src/bridges/*.ts" } }', "wildcard"],
    ['{ "name": "@repo/ui", "exports": { ".": "./src/index.ts", "./fake.css": "./src/client.ts" } }', "non-asset target"],
    ['{ "name": "@repo/ui", "exports": {} }', "Empty"],
    ['{ "name": "@repo/ui", "exports": { ".": "./src/index.ts", "import": "./dist/index.js" } }', "subpath map"],
    ['{ "name": "@repo/ui", "publishConfig": { "exports": { ".": "./dist/index.js", "./client": "./dist/client.js" } } }', "barrel/exports"],
    ['{\n  "name": "@repo/ui",\n  "exports": { "./client": "./src/client.ts" },\n  "exports": { ".": "./src/index.ts" }\n}', "barrel/exports"],
    ['{ "name": "@repo/ui", "main": "./src/index.ts", "exports": { "./styles.css": "./styles.css" } }', "asset-only"],
    ['{\n  "name": "@repo/ui",\n}', "3:1 fatal"],
  ] as const) {
    const msgs = await barrelHits(live, "packages/ui/package.json", [badManifest]);
    assert.ok(msgs.length >= 1 && msgs.some((m) => m.includes(snippet)), `${badManifest} -> ${JSON.stringify(msgs)}`);
  }

  assert.deepEqual(await barrelHits(live, "package.json", [read("package.json")]), []);

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "barrel-lint-")));
  context.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const writeTmp = (rel: string, body: string) => {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  };
  writeTmp("pnpm-workspace.yaml", [
    "packages: # workspace members",
    "  - 'packages/*'",
    "  - !packages/ignored",
    "  - apps/*",
    "  - cloud",
    "  - vendor/eliza",
    "  - vendor/eliza/packages/*",
    "catalog:",
    "  react: ^19.3.1",
  ].join("\n"));
  writeTmp("tsconfig.json", JSON.stringify({ compilerOptions: { target: "es2023", module: "nodenext", strict: true, noEmit: true }, include: ["apps/**/*.ts"] }));
  writeTmp("packages/agent/package.json", JSON.stringify({ name: "@elizaos/agent", exports: { ".": "./src/index.ts", "./client": "./src/client.ts", "./bridges/*": "./src/bridges/*.ts" } }));
  writeTmp("packages/ignored/package.json", JSON.stringify({ name: "@elizaos/ignored", exports: { ".": "./src/index.ts", "./secret": "./src/secret.ts" } }));
  writeTmp("cloud/package.json", JSON.stringify({ name: "cloud", exports: { "./worker": "./src/worker.ts" } }));
  writeTmp("vendor/eliza/package.json", JSON.stringify({ name: "vibestack", bin: { spec: "dist/spec.js" }, exports: { "./testing/vitest": "./vibestack/testing/vitest.ts" } }));
  writeTmp("vendor/eliza/packages/core/package.json", JSON.stringify({ name: "@elizaos/core", exports: { ".": "./src/index.ts", "./protocol": "./src/protocol.ts" } }));
  writeTmp("apps/web/src/other.ts", 'import "@elizaos/agent/client";\n');

  const scratchEslint = new ESLint({
    cwd: tmp,
    overrideConfigFile: true,
    overrideConfig: withWorkspaceBarrels(
      defineConfig(
        globalIgnores(["vendor/**"]),
        js.configs.recommended,
        tseslint.configs.recommendedTypeChecked,
        { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: tmp } } },
        { files: ["**/*.vibe"], extends: [tseslint.configs.disableTypeChecked], languageOptions: { parser: vibelang, parserOptions: { projectService: false } } },
      ),
      {
        root: tmp,
        allowExports: { "packages/agent/package.json": ["./client"] },
        allowImports: { "apps/web/src/app.vibe": ["@elizaos/agent/client", "@elizaos/core/protocol"] },
      },
    ),
  });

  const agentMsgs = await barrelHits(scratchEslint, "packages/agent/package.json", [read("packages/agent/package.json", tmp)], tmp);
  assert.equal(agentMsgs.length, 1);
  assert.ok(agentMsgs[0]!.includes("./bridges/*"));
  const staleExportMsgs = await barrelHits(scratchEslint, "packages/agent/package.json", [JSON.stringify({ name: "@elizaos/agent", exports: { ".": "./src/index.ts" } })], tmp);
  assert.ok(staleExportMsgs.some((m) => m.includes('Stale allowExports entry "./client"')));
  assert.equal((await barrelHits(scratchEslint, "cloud/package.json", [read("cloud/package.json", tmp)], tmp)).length, 1);

  assert.deepEqual(await barrelHits(scratchEslint, "apps/web/src/app.vibe", [
    'import "@elizaos/agent/client"',
    'import "@elizaos/core/protocol"',
    'import "vibestack/testing/vitest"',
  ], tmp), []);
  const newAppMsgs = await barrelHits(scratchEslint, "apps/web/src/app.vibe", [
    'import "@elizaos/agent/client"',
    'import "@elizaos/agent/bridges/http"',
    'import "cloud/worker"',
  ], tmp);
  assert.equal(newAppMsgs.length, 3, newAppMsgs.join("\n"));
  assert.ok(newAppMsgs.some((m) => m.includes('@elizaos/agent/bridges/http')));
  assert.ok(newAppMsgs.some((m) => m.includes('cloud/worker')));
  assert.ok(newAppMsgs.some((m) => m.includes('Stale allowImports entry "@elizaos/core/protocol"')));

  const otherMsgs = await barrelHits(scratchEslint, "apps/web/src/other.ts", ['import "@elizaos/agent/client";'], tmp);
  assert.equal(otherMsgs.length, 1);
  assert.ok(otherMsgs[0]!.includes('barrel/no-subpath-imports'));

  const flowDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "barrel-flow-")));
  context.after(() => fs.rmSync(flowDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(flowDir, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
  fs.mkdirSync(path.join(flowDir, "packages/kit"), { recursive: true });
  fs.writeFileSync(path.join(flowDir, "packages/kit/package.json"), JSON.stringify({ name: "@flow/kit", exports: { ".": "./index.ts", "./sub": "./sub.ts" } }));
  const fallbackEslint = new ESLint({ cwd: flowDir, overrideConfigFile: true, overrideConfig: withWorkspaceBarrels([], { root: flowDir }) });
  assert.equal((await barrelHits(fallbackEslint, "packages/kit/package.json", [read("packages/kit/package.json", flowDir)], flowDir)).length, 1);

  fs.writeFileSync(path.join(flowDir, "pnpm-workspace.yaml"), 'packages: ["packages/*", "!packages/skip"]\n');
  fs.mkdirSync(path.join(flowDir, "packages/skip"), { recursive: true });
  fs.writeFileSync(path.join(flowDir, "packages/skip/package.json"), JSON.stringify({ name: "@flow/skip", exports: { ".": "./index.ts", "./sub": "./sub.ts" } }));
  const flowEslint = new ESLint({ cwd: flowDir, overrideConfigFile: true, overrideConfig: withWorkspaceBarrels([], { root: flowDir }) });
  assert.equal((await barrelHits(flowEslint, "apps/a.ts", ['import "@flow/kit/sub"; import "@flow/skip/sub";'], flowDir)).length, 1);

  assert.throws(() => withWorkspaceBarrels([], { root: tmp, allowExports: { "packages/agent/package.json": ["."] } }), /never be "."/);
  assert.throws(() => withWorkspaceBarrels([], { root: tmp, allowExports: { "packages/agent": ["./client"] } }), /package\.json/);
  assert.throws(() => withWorkspaceBarrels([], { root: tmp, allowImports: { "apps/a.ts": ["@elizaos/agent"] } }), /subpath specifier/);
});
