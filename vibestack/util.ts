import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { exec } from "./run.ts";
import { heading, isStd, type Spec } from "./parse.ts";
import type { Result } from "./pipeline.ts";
import ts from "typescript";
import { profile, type TestProfile } from "./testing/profile.ts";

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
/** A hash of several texts, in which no two lists of texts give the same input. */
export const sha = (...parts: string[]) => digest(JSON.stringify(parts));
export const short = (text: string) => digest(text).slice(0, 12);
export const indent = (s: string, by = 6) => s.split("\n").map((l) => " ".repeat(by) + l).join("\n");
/** What each promise gives, once every one has finished: a failure is thrown only then, so that nothing is left running. */
export async function allDone<T>(promises: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(promises);
  const failure = settled.find((r) => r.status === "rejected");
  if (failure) throw failure.reason;
  return settled.map((r) => (r as PromiseFulfilledResult<T>).value);
}

/** Write a file whole or not at all: to a file of its own beside it, then renamed into place. */
export function writeWhole(file: string, text: string | Uint8Array) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, text);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Files and symbolic links below a project directory, excluding directory entries. */
export const filesUnder = (root: string, dir: string) => !fs.existsSync(path.join(root, dir)) ? []
  : fs.readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true }).filter((e) => e.isFile() || e.isSymbolicLink())
    .map((e) => path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join("/")).sort();

const sidecarSource = /^(.*?)(?:\.vibex?\.[^./]+\.d\.ts|\.d\.vibex?\.tsx?|\.d\.ts)$/;

export function pruneSidecars(dir: string) {
  const { config } = ts.readConfigFile(path.join(dir, "tsconfig.json"), ts.sys.readFile);
  const sidecarDir = config?.vibe?.sidecarDir;
  if (typeof sidecarDir !== "string") return;
  const sidecars = path.resolve(dir, sidecarDir);
  for (const mirror of ts.parseJsonConfigFileContent(config, ts.sys, dir).options.rootDirs ?? []) {
    const within = path.relative(sidecars, mirror);
    if (within.startsWith("..") || path.isAbsolute(within)) continue;
    const base = path.resolve(dir, ...within.split(path.sep).filter(Boolean).map(() => ".."));
    for (const file of filesUnder(sidecars, "")) {
      const stem = sidecarSource.exec(file)?.[1];
      if (stem && ![".vibe", ".vibex"].some((ext) => fs.existsSync(path.join(base, stem + ext)))) fs.rmSync(path.join(sidecars, file), { force: true });
    }
  }
}

/** What a package's tsconfig.json names: itself, the configurations it extends and the files it includes, VibeLang's among them. */
export function configured(dir: string): string[] {
  const config = path.resolve(dir, "tsconfig.json");
  const source = ts.readJsonConfigFile(config, ts.sys.readFile);
  const { fileNames } = ts.parseJsonSourceFileConfigFileContent(source, ts.sys, path.dirname(config), undefined, config, undefined,
    [".vibe", ".vibex"].map((extension) => ({ extension, isMixedContent: false, scriptKind: ts.ScriptKind.Deferred })));
  return [config, ...source.extendedSourceFiles ?? [], ...fileNames];
}

/** Resolve a project folder before a command reads or writes its files. */
export function projectRoot(directory: string, base = process.cwd()): string {
  const root = path.resolve(base, directory);
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`${directory}: not an existing project directory`);
  return fs.realpathSync(root);
}

/** The declarations the VibeLang compiler writes for a `.vibe` module: its output, not the package's code. */
const SIDECAR = /\.d\.vibex?\.ts$/;

/**
 * The workspace package a spec belongs to by name, as a path from the root: `spec/<name>/…` is `apps/<name>` or
 * `packages/<name>`, if that is a package with no `spec/` of its own. The root's check generates into its `gen/` and
 * checks its code (SPEC.md, "One spec tree").
 */
export function owner(root: string, spec: string): string | undefined {
  const [top, name, below] = spec.split("/");
  if (top !== "spec" || below === undefined) return undefined;
  return [`apps/${name}`, `packages/${name}`].find((dir) => fs.existsSync(path.join(root, dir, "package.json")) && !fs.existsSync(path.join(root, dir, "spec")));
}
/**
 * The directories whose code a check reads, each as the prefix of a path from the root: "" for the root's own
 * `src/` and `test/`, then `apps/app/` for each package that owns a directory of the spec tree.
 */
export const codeDirs = (root: string): string[] => ["", ...!fs.existsSync(path.join(root, "spec")) ? []
  : [...new Set(fs.readdirSync(path.join(root, "spec")).flatMap((name) => owner(root, `spec/${name}/`) ?? []))].sort().map((dir) => `${dir}/`)];
/** Which of `codeDirs` a path from the root is in: the root holds no `apps/` or `packages/` code of its own. */
export const codeDirOf = (file: string): string => file.match(/^(?:(?:apps|packages)\/[^/]+\/)?/)![0];

/** A file with `//@` under a `src/` the check reads; `file` is its path from the root (`src/x.ts`, `apps/app/src/x.ts`). */
export interface SrcFile { file: string; code: string; ts: boolean }
/** Every such file, read once: a check proves and reviews the same text, even if a file changes while it runs. */
export function readSrc(root: string): SrcFile[] {
  const files = codeDirs(root).flatMap((dir) => filesUnder(root, `${dir}src`)).filter((f) => /\.(?:[mc]?ts|tsx|[mc]?jsx?|vibex?)$/.test(f) && !SIDECAR.test(f));
  return files.map((f) => ({ file: f, code: fs.readFileSync(path.join(root, f), "utf8"), ts: /\.ts$/.test(f) })).filter((u) => u.code.includes("//@"));
}

/** One result as `report` in spec.ts takes it. */
export type Reported<S extends Result["stage"] = Result["stage"]> = [ok: boolean, stage: S, summary: string, detail?: string, where?: string];

/** A directory's package.json, or nothing; one that is not JSON is refused with its path. */
/** A package's package.json, or nothing where it has none. */
export function manifest(dir: string) {
  const file = path.join(dir, "package.json");
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`, { cause: e });
  }
}
/** A package's scripts. */
export const packageScripts = (root: string): Record<string, string> => manifest(root).scripts ?? {};

/** The script that runs the package's app, for Studio's preview and the explore stage: `start`, or `dev` when that is not the studio. */
export function appScript(root: string): "start" | "dev" | undefined {
  const scripts = packageScripts(root);
  return scripts.start ? "start" : scripts.dev && !/\bspec(\.ts)? studio\b/.test(scripts.dev) ? "dev" : undefined;
}

/** A terminal colour code, which development servers print around their address. */
export const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
/** The address a development server says it serves at, in a line it printed. @throws {never} */
export const servedAt = (line: string) => line.replace(COLOUR, "").match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+[^\s]*/)?.[0];

/** The configuration every package shares (vibestack/testing/vitest.ts): `spec init` writes it, and `check` where test/ has nothing to run it. */
export const VITEST_CONFIG = `import { project } from "vibestack/testing/vitest";\n\nexport default project({ root: import.meta.dirname });\n`;

/** `run()`, or what it returned the last time for the same fingerprint, if `keep` kept it then (cache.ts). */
export type Remember = <T>(fingerprint: string, run: () => Promise<T>, keep: (result: T) => boolean) => Promise<T>;

/**
 * The tests stage of one of `codeDirs`: the rules its tests are held to, then its own `test` script, run in its
 * directory. A pass is remembered until something the tests read changes; in a `check` that Turborepo runs, which
 * waits for the package's `test`, the script has just run and is not run again.
 */
export async function tests(checking: string, dir: string, specs: Spec[], remember: Remember, mode: TestProfile = "normal", fresh = false): Promise<Reported<"tests">[]> {
  const said: Reported<"tests">[] = [];
  const root = path.join(checking, dir);
  try {
    const dangling = danglingCitations(checking, specs, dir);
    if (dangling.length) said.push([false, "tests", `${dangling.length} citations name no story or rule of the spec`, indent(dangling.join("\n"))]);
    const oracle = driverImports(root).map((problem) => dir + problem);
    if (oracle.length) said.push([false, "tests", "a driver imports gen/ as types only: it reaches the application, and the spec is the oracle the traces stage compares it with", indent(oracle.join("\n"))]);
    said.push(...testRules(checking, dir, specs));
    // The package's own tests, in whatever runner it chose (AGENTS.md, "Tests"). test/ with nothing to run it gets
    // Vitest, as `spec init` sets it up; the placeholder `npm init` writes is no script.
    const scripts = packageScripts(root);
    let script = /no test specified/.test(scripts.test ?? "") ? undefined : scripts.test;
    if (!script && fs.existsSync(path.join(root, "test"))) {
      said.push([true, "tests", addVitest(root)]);
      script = "vitest run";
    }
    if (!script) return said;
    const manager = packageManager(root);
    const fingerprint = testInputs(root, mode);
    if (!fresh) {
      try {
        if (JSON.parse(fs.readFileSync(testReceipt(root, mode), "utf8")).fingerprint === fingerprint) {
          said.push([true, "tests", "pass: the test runner recorded success for these inputs"]);
          return said;
        }
      } catch { /* no matching successful test run */ }
    }
    said.push(await remember(fingerprint, async (): Promise<Reported<"tests">> => {
      const { NODE_TEST_CONTEXT: _, ...env } = process.env;
      // The root that is checking: spec.ts refuses a check of it, or of a package below it, started from these tests.
      const t = await exec(manager.name, ["run", "test", ...(mode === "nightly" ? ["--mode", "nightly"] : [])], root, { ...env, SPEC_TESTS: fs.realpathSync(checking) });
      const ok = t.status === 0 && !t.stopped;
      // From the runner's list of failures, Vitest's or Node's, at most 200 lines of it; else the end of what it said.
      const stdout = stripVTControlCharacters(t.stdout), stderr = stripVTControlCharacters(t.stderr);
      const lines = `${stdout}${stderr}`.split("\n");
      const first = lines.findIndex((l) => /✖ failing tests:|⎯.*Failed (?:Suites|Tests) \d+/.test(l));
      const shown = first < 0 ? stdout.split("\n").slice(-80).join("\n") + stderr
        : [...lines.slice(first, first + 200), ...lines.length > first + 200 ? [`… ${lines.length - first - 200} more lines`] : []].join("\n");
      return [ok, "tests", ok ? "pass" : "fail", indent((shown + (t.stopped ? `\n${t.stopped}` : "")).trim()), `${manager.name} run test`];
    }, ([ok]) => ok));
  } catch (e) {
    said.push([false, "tests", (e as Error).message]);
  }
  return said;
}

/** Set a package up to run test/ with Vitest, as `spec init` does, and say what was added. */
function addVitest(root: string): string {
  const json = manifest(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ ...json, scripts: { ...json.scripts, test: "vitest run" } }, null, 2) + "\n");
  const config = !fs.readdirSync(root).some((f) => /^vitest\.config\.[cm]?[jt]s$/.test(f));
  if (config) fs.writeFileSync(path.join(root, "vitest.config.ts"), VITEST_CONFIG);
  return `test/ had nothing to run it: added "test": "vitest run" to package.json${config ? ", and vitest.config.ts" : ""}, as \`spec init\` does`;
}

/**
 * What a fingerprint covers: what a package's tests read, or what its typecheck may read, its scripts and JSON but the
 * traces and counterexamples. What its page reads is explore.ts's `pageInputs`.
 */
export type Inputs = "tests" | "types";

/** What no test reads: a spec's prose and its Quint copy, and the prose `spec init` and these tools keep for people and agents at a package's top. */
const PROSE = /^spec\/.*\.md$|^gen\/[^/]*\.qnt$|^(?:README|AGENTS|CLAUDE|CONTRIBUTING|SPEC)\.md$/;

/** A package and the workspace packages it depends on, and theirs, each once: by its real directory and the name it is depended on by. */
export function workspacePackages(root: string): { directory: string; name: string }[] {
  const found = new Map<string, string>();
  const pending = [{ directory: root, name: "." }];
  for (const { directory, name } of pending) {
    const from = fs.realpathSync(directory);
    if (found.has(from)) continue;
    found.set(from, name);
    const pkg = manifest(from);
    for (const [dependency, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).sort(([a], [b]) => a.localeCompare(b))) {
      const at = path.join(from, "node_modules", dependency);
      if (String(version).startsWith("workspace:") && fs.existsSync(at)) pending.push({ directory: at, name: dependency });
    }
  }
  return [...found].map(([directory, name]) => ({ directory, name }));
}

/** A relative module a script names, by import, export or `import()`. */
const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)["'](\.\.?\/[^"']+)["']/gm;

/**
 * A fingerprint of what a package's tests or its typecheck read: its files but `PROSE` and the simulations' traces, and
 * the top of its gen/ (an owner's is mirrored from the root's), the fixtures nested under its test/, the workspace packages it depends on, the lock file
 * and the fuzzing budget. Of a workspace package depended on, only what a dependent can load: not its spec/, Markdown
 * outside fixtures/, tests, drivers, traces or counterexamples, nor the packages nested in it, nor its gen/ unless its
 * scripts or its manifest reach into it.
 */
export function testInputs(root: string, mode: TestProfile = "normal", read: Inputs = "tests"): string {
  const hash = createHash("sha256").update(JSON.stringify(["tests-v6", read, process.versions.node, process.platform, process.arch, profile(mode)]));
  const served = (file: string) => !isTestFile(file) && ![DRIVERS, TRACES, COUNTEREXAMPLES].some((dir) => file.startsWith(`${dir}/`));
  const reads: Record<Inputs, (file: string) => boolean> = {
    tests: (file) => !PROSE.test(file) && !file.startsWith(`${SIMULATIONS}/`),
    types: (file) => /\.(?:[cm]?[jt]sx?|json|vibex?)$/.test(file) && ![TRACES, COUNTEREXAMPLES, SIMULATIONS].some((dir) => file.startsWith(`${dir}/`)),
  };
  const update = (from: string, file: string) => {
    const bytes = fs.readFileSync(path.join(from, file));
    hash.update(`${file}\0${bytes.length}\0`).update(bytes);
    return bytes;
  };
  for (const { directory: from, name } of workspacePackages(root)) {
    hash.update(JSON.stringify(name));
    const own = name === ".";
    const keep = (file: string) => reads[read](file) && (own || (served(file) && !/^(?:spec|gen)\//.test(file) && (!file.endsWith(".md") || /(?:^|\/)fixtures\//.test(file))));
    const pkg = manifest(from);
    let gen = own || /(?:^|["/.])gen\//.test(JSON.stringify([pkg.exports, pkg.main, pkg.module, pkg.types]));
    for (const file of packageFiles(from, keep, "", own)) {
      const bytes = update(from, file);
      if (!gen && /\.(?:[cm]?[jt]sx?|vibex?)$/.test(file))
        gen = [...bytes.toString("utf8").matchAll(SPECIFIER)].some(([, to]) => path.posix.join(path.posix.dirname(file), to).startsWith("gen/"));
    }
    const top = gen && fs.existsSync(path.join(from, "gen")) ? fs.readdirSync(path.join(from, "gen"), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => `gen/${e.name}`) : [];
    for (const file of top.filter(reads[read])) update(from, file);
  }
  const { lock } = packageManager(root);
  if (lock) hash.update(fs.readFileSync(lock));
  return hash.digest("hex");
}

/** A successful complete Node test run, also restored by the Turbo test task. */
export const testReceipt = (root: string, mode: TestProfile = "normal") => path.join(root, ".cache", `test-result-${mode}.json`);

/** Where code cites a story or rule (AGENTS.md, "Tests"). */
const CITATION = /(?<![\w/.-])(spec\/(?:[A-Za-z0-9]+\/)*[A-Za-z0-9]+\.md), "([^"]+)"/g;
/** A citation of `heading` in `spec`; `at` is `file:line`, a path from the checking root. */
export interface Citation { at: string; spec: string; heading: string }
/** Every citation in the code of `dirs`, which are `codeDirs` (all of them unless given): an owner cites as the root does. */
export const citations = (root: string, dirs = codeDirs(root)): Citation[] => dirs.flatMap((dir) => packageCode(path.join(root, dir)).map((f) => dir + f)
  .flatMap((f) => fs.readFileSync(path.join(root, f), "utf8").split("\n").flatMap((line, i) => [...line.matchAll(CITATION)].map(([, spec, heading]) => ({ at: `${f}:${i + 1}`, spec, heading })))));

/** Every citation in a package's code whose heading is no story or rule of that spec, as `file:line  citation`. */
export function danglingCitations(root: string, specs: Spec[], dir = ""): string[] {
  const names = (s: Spec, h: string) => s.stories.some((t) => t.title === h) || s.rules.some((r) => heading(r) === h);
  return citations(root, [dir]).filter((c) => !specs.some((s) => s.file === c.spec && names(s, c.heading))).map((c) => `${c.at}  ${c.spec}, "${c.heading}"`);
}

/** A directory no stage reads in a package: build output, dependencies, saved explorations and hidden directories. */
export const UNREAD = /^(node_modules|dist|build|out|coverage|storybook-static|__traces__|__screenshots__|\..*)$/;

/**
 * A package's files that `keep` accepts, as paths from it: not gen/, build output, dependencies, hidden directories
 * (such as `.cache/`) or `.DS_Store`, nor the packages nested in it, which are checked on their own, except, with
 * `fixtures`, those under a test/ directory, which its tests read.
 */
export function packageFiles(root: string, keep: (file: string) => boolean, dir = "", fixtures = false): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.name === ".git" || e.name === ".DS_Store") return [];
    if (e.isFile()) return keep(rel) ? [rel] : [];
    const nested = fs.existsSync(path.join(root, rel, "package.json"));
    const skip = UNREAD.test(e.name)
      || (nested && (e.name === "gen" || !fixtures || !/(?:^|\/)test\//.test(rel)));
    return e.isDirectory() && !skip ? packageFiles(root, keep, rel, fixtures) : [];
  }).sort();
}
const packageCode = (root: string) => packageFiles(root, (file) => /\.(?:[cm]?[jt]sx?|vibex?)$/.test(file) && !SIDECAR.test(file));

/** A test of a package: test/**\/*.test.*, but not a driver, which the traces stage runs. */
export const isTestFile = (file: string) => /^test\/(?!drivers\/).*\.test\.[^/.]+$/.test(file);
const testFiles = (root: string) => packageCode(root).filter(isTestFile);

/** Where a package keeps its drivers, the traces they replay and the counterexamples the simulator found (SPEC.md, "Conformance"). */
export const TRACES = "test/traces", DRIVERS = "test/drivers", COUNTEREXAMPLES = "test/counterexamples";
/** Where Quint writes the traces of the simulations a check ran. */
export const SIMULATIONS = "gen/traces";

/** A token of a script, and how many brackets it sits in. */
interface Token { text: string; pos: number; start: number; depth: number; fresh: boolean }
/** A script's tokens, or nothing if its brackets do not balance; TypeScript's scanner reads VibeLang's too. */
export function tokenize(text: string): Token[] | undefined {
  const K = ts.SyntaxKind;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const out: Token[] = [];
  const open: boolean[] = []; // each bracket that is open: true for a template's `${`
  for (let kind = scanner.scan(); kind !== K.EndOfFileToken; kind = scanner.scan()) {
    // A slash after a value divides; anywhere else it starts a regular expression.
    const last = out.at(-1)?.text ?? "";
    if ((kind === K.SlashToken || kind === K.SlashEqualsToken) && !(/[\w$)\]}'"`]$/.test(last) && !/^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(last)))
      kind = scanner.reScanSlashToken();
    if (kind === K.CloseBraceToken && open.at(-1)) kind = scanner.reScanTemplateToken(false);
    if (kind === K.CloseParenToken || kind === K.CloseBracketToken || kind === K.CloseBraceToken || kind === K.TemplateTail) {
      if (!open.length) return undefined;
      open.pop();
    }
    out.push({ text: scanner.getTokenText(), pos: scanner.getTokenFullStart(), start: scanner.getTokenStart(), depth: open.length, fresh: scanner.hasPrecedingLineBreak() });
    if (kind === K.OpenParenToken || kind === K.OpenBracketToken || kind === K.OpenBraceToken || kind === K.TemplateHead) open.push(kind === K.TemplateHead);
  }
  return open.length ? undefined : out;
}

/** What a module import reaches: generated code, a test library, or anything else (the shell, a service, a helper). */
const reaches = (quoted: string) => {
  const module = quoted.replace(/^["'`]|["'`]$/g, "");
  return /(?:^|\/)gen\//.test(module) ? "gen" : /^(?:vitest|@vitest\/.+|@effect\/vitest|effect(?:\/.+)?|node:test|node:assert(?:\/strict)?|assert|@testing-library\/.+)$/.test(module) ? "library" : "outside";
};

/**
 * The tests of one file, each as its line, whether it reaches only generated code and whether a citation covers it;
 * `generated` when the file imports nothing but gen/ and test libraries. A test is a call of `it` or `test` and what
 * it calls in the same file; it is covered by a citation in it, on the `describe` or layer around it, or in the
 * file's header. Nothing, if the file cannot be read as tokens.
 */
function readTests(text: string): { generated: boolean; tests: { line: number; generatedOnly: boolean; cited: boolean }[] } | undefined {
  const tokens = tokenize(text);
  if (!tokens) return undefined;
  const word = (i: number) => /^[A-Za-z_$][\w$]*$/.test(tokens[i]?.text ?? "");
  /** The bracket that closes the one at `i`: the next token as deep. */
  const close = (i: number) => tokens.findIndex((t, j) => j > i && t.depth === tokens[i].depth);
  // Top-level statements: a word that starts a line outside every bracket, unless the line before ends in an operator.
  const starts = tokens.flatMap((t, i) => t.depth === 0 && (i === 0 || t.fresh && word(i) && !/[=,.:?+\-*/%&|^<>!~]$/.test(tokens[i - 1].text)) ? [i] : []);
  const statements = starts.map((from, n) => ({ from, to: (starts[n + 1] ?? tokens.length) - 1 }));
  const bound = new Map<string, ReturnType<typeof reaches>>();
  const runners = new Set(["it", "test"]);
  const runnerNamespaces = new Set<string>();
  const helpers = new Map<string, { from: number; to: number }>();
  let header = text.length;
  for (const s of statements) {
    let i = s.from;
    if (tokens[i].text === "import" && tokens[i + 1]?.text !== "(") {
      if (tokens[i + 1].text === "type") continue;
      const fromAt = tokens.findIndex((t, j) => j > i && j <= s.to && t.text === "from");
      const module = tokens[fromAt < 0 ? i + 1 : fromAt + 1].text;
      if (/^["'](?:vitest|@effect\/vitest|node:test)["']$/.test(module)) {
        if (tokens[i + 1]?.text === "*" && tokens[i + 2]?.text === "as") runnerNamespaces.add(tokens[i + 3].text);
        else if (word(i + 1)) runners.add(tokens[i + 1].text);
        for (let j = i + 1; j < fromAt; j++) if (["it", "test"].includes(tokens[j].text) && tokens[j - 1]?.text !== "type")
          runners.add(tokens[j + 1]?.text === "as" ? tokens[j + 2].text : tokens[j].text);
      }
      for (let j = i + 1; j < (fromAt < 0 ? i : fromAt); j++)
        if (word(j) && !["type", "as"].includes(tokens[j].text) && tokens[j - 1].text !== "type" && tokens[j + 1]?.text !== "as") bound.set(tokens[j].text, reaches(module));
      if (fromAt < 0) bound.set(`import ${module}`, reaches(module));
      continue;
    }
    header = Math.min(header, tokens[s.from].pos);
    while (["export", "default", "declare", "async", "effect"].includes(tokens[i].text)) i++;
    const declares = ["function", "class"].includes(tokens[i].text) ? [tokens[i + 1].text === "*" ? i + 2 : i + 1]
      : !["const", "let", "var"].includes(tokens[i].text) ? [] : word(i + 1) ? [i + 1]
      : ["{", "["].includes(tokens[i + 1]?.text) ? Array.from({ length: close(i + 1) - i - 2 }, (_, k) => i + 2 + k).filter(word) : [];
    for (const d of declares) helpers.set(tokens[d].text, s);
  }
  const blocks: { from: number; to: number }[] = [];
  tokens.forEach((t, i) => {
    let j = i + 1;
    if ([".", "function"].includes(tokens[i - 1]?.text)) return;
    if (runnerNamespaces.has(t.text) && tokens[j]?.text === "." && ["it", "test"].includes(tokens[j + 1]?.text)) j += 2;
    else if (runnerNamespaces.has(t.text) && tokens[j]?.text === "[" && /^["'](?:it|test)["']$/.test(tokens[j + 1]?.text ?? "") && tokens[j + 2]?.text === "]") j += 3;
    else if (!runners.has(t.text)) return;
    while (tokens[j]?.text === "." && word(j + 1)) j += 2;
    if (tokens[j]?.text !== "(") return;
    let to = close(j);
    while (tokens[to + 1]?.text === "(") to = close(to + 1);
    blocks.push({ from: i, to });
  });
  const ranges = [...statements, ...blocks];
  /** Where the code of a statement or test that comes before the first test inside it ends. */
  const inner = (r: { from: number; to: number }) => Math.min(r.to + 1, ...blocks.filter((b) => b !== r && b.from >= r.from && b.to <= r.to).map((b) => b.from));
  const textOf = (from: number, to: number) => text.slice(tokens[from].pos, to < tokens.length ? tokens[to].pos : text.length);
  const cites = (s: string) => new RegExp(CITATION.source).test(s);
  const outsideNamed = (from: number, to: number) => tokens.slice(from, to).some((t, k) => t.text === "import" && tokens[from + k + 1]?.text === "(" && reaches(tokens[from + k + 2]?.text ?? "") === "outside");
  const imported = [...bound.values()];
  return {
    generated: imported.includes("gen") && !imported.includes("outside") && !outsideNamed(0, tokens.length),
    tests: blocks.map((b) => {
      const around = ranges.filter((r) => r !== b && r.from <= b.from && b.to <= r.to);
      // The names the test reaches, through the helpers of the file it calls.
      const named = new Set<string>();
      const seen = new Set<object>();
      const visit = (from: number, to: number) => {
        if (outsideNamed(from, to)) named.add("import()");
        for (let i = from; i < to; i++) {
          const helper = word(i) && helpers.get(tokens[i].text);
          if (word(i)) named.add(tokens[i].text);
          if (helper && !seen.has(helper)) {
            seen.add(helper);
            visit(helper.from, helper.to + 1);
          }
        }
      };
      visit(b.from, b.to + 1);
      for (const r of around) visit(r.from, inner(r));
      const kinds = [...named].map((n) => n === "import()" ? "outside" : bound.get(n));
      return {
        line: text.slice(0, tokens[b.from].start).split("\n").length,
        generatedOnly: kinds.includes("gen") && !kinds.includes("outside"),
        cited: cites(text.slice(0, header)) || cites(textOf(b.from, b.to + 1)) || around.some((r) => cites(textOf(r.from, inner(r)))),
      };
    }),
  };
}

/**
 * The rules a package's tests are held to (AGENTS.md, "Tests"): each reaches past generated code, which the spec
 * proves, and cites what it serves. Beside them, notes: test files to consolidate, and specs of this package that
 * its src/ may shell but that no test or driver checks.
 */
function testRules(checking: string, dir: string, specs: Spec[]): Reported<"tests">[] {
  const root = path.join(checking, dir);
  const files = testFiles(root);
  const generatedOnly: string[] = [];
  const uncited: string[] = [];
  const said: Reported<"tests">[] = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    const read = readTests(text);
    if (read?.generated) generatedOnly.push(`${dir}${file}: imports nothing but gen/ and test libraries`);
    for (const t of read?.tests ?? []) {
      if (t.generatedOnly && !read!.generated) generatedOnly.push(`${dir}${file}:${t.line}`);
      if (!t.cited) uncited.push(`${dir}${file}:${t.line}`);
    }
    const lines = text.split("\n").length;
    if (lines >= 15_000) said.push([true, "tests", `note: ${dir}${file} has ${lines} lines; at 15,000, consolidate and simplify it`]);
  }
  if (generatedOnly.length) said.push([false, "tests", `${generatedOnly.length} tests touch only generated code, which the spec proves: route each through src/, or propose deleting it`, indent(generatedOnly.join("\n"))]);
  if (uncited.length) said.push([false, "tests", `${uncited.length} tests cite no story or rule: cite the one each serves, fold it into the journey that does, or propose deleting it`, indent(uncited.join("\n"))]);
  // One file per package and runner is the norm: a browser test is another runner, a .vibe test another language.
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const key = `${/\.browser\.test\./.test(f)} ${/\.vibex?$/.test(f)}`;
    groups.set(key, [...groups.get(key) ?? [], dir + f]);
  }
  for (const group of groups.values()) if (group.length > 1) said.push([true, "tests", `note: ${group.join(", ")} run in one runner, in one language; one test file each is the norm, so consolidate them`]);
  if (fs.existsSync(path.join(root, "src"))) {
    const scripts = packageScripts(root);
    const checked = new Set(citations(checking, [dir]).filter((c) => c.at.startsWith(`${dir}test/`)).map((c) => c.spec));
    const unchecked = specs.filter((s) => s.stories.length && !isStd(s.file) && (owner(checking, s.file) ?? "") === dir.slice(0, -1) && !checked.has(s.file)
      && !fs.existsSync(path.join(root, "test/drivers", `${s.name}.ts`)) && !fs.existsSync(path.join(root, "test/traces", `${s.name}.jsonl`)) && !(`driver:${s.name}` in scripts));
    if (unchecked.length) said.push([true, "tests", `note: no test or driver checks ${unchecked.map((s) => s.file).join(", ")}; a story that leaves the verified core needs a journey that cites it`]);
  }
  return said;
}

/** Each place a `test/drivers/` module of the package `root` imports or re-exports `gen/` as a value, as `file:line: module`. */
function driverImports(root: string): string[] {
  const files = packageCode(root).filter((file) => file.startsWith("test/drivers/"));
  if (!files.length) return [];
  const config = ts.findConfigFile(root, ts.sys.fileExists);
  const options = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    ...config ? ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} })?.options : {} };
  const cache = ts.createModuleResolutionCache(root, (file) => file, options);
  return files.flatMap((file) => {
    const source = ts.createSourceFile(path.resolve(root, file), fs.readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
    const host = ts.createCompilerHost({ noResolve: true, noLib: true });
    host.getSourceFile = (file) => file === source.fileName ? source : undefined;
    const checker = ts.createProgram([source.fileName], { noResolve: true, noLib: true }, host).getTypeChecker();
    const moduleName = (node: ts.Node | undefined, seen = new Set<ts.Symbol>()): string | undefined => {
      if (!node) return undefined;
      if (ts.isStringLiteralLike(node)) return node.text;
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return moduleName(node.expression, seen);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = moduleName(node.left, seen), right = moduleName(node.right, seen);
        return left === undefined || right === undefined ? undefined : left + right;
      }
      if (ts.isTemplateExpression(node)) {
        let text = node.head.text;
        for (const span of node.templateSpans) { const value = moduleName(span.expression, seen); if (value === undefined) return undefined; text += value + span.literal.text; }
        return text;
      }
      const symbol = ts.isIdentifier(node) ? checker.getSymbolAtLocation(node) : undefined;
      const declaration = symbol?.valueDeclaration;
      if (!symbol || seen.has(symbol) || !declaration || !ts.isVariableDeclaration(declaration) || !(declaration.parent.flags & ts.NodeFlags.Const)) return undefined;
      return moduleName(declaration.initializer, new Set([...seen, symbol]));
    };
    const typesOnly = (node: ts.ImportDeclaration | ts.ExportDeclaration) => ts.isImportDeclaration(node)
      ? !!node.importClause && (node.importClause.isTypeOnly || !node.importClause.name && !!node.importClause.namedBindings
        && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.length > 0 && node.importClause.namedBindings.elements.every((e) => e.isTypeOnly))
      : node.isTypeOnly || !!node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every((e) => e.isTypeOnly);
    const found: string[] = [];
    const visit = (node: ts.Node) => {
      const module = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && !typesOnly(node) ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
      const name = moduleName(module);
      const resolved = name && ts.resolveModuleName(name, source.fileName, options, ts.sys, cache, undefined, ts.ModuleKind.ESNext).resolvedModule?.resolvedFileName;
      if (name !== undefined && /(?:^|\/)gen\//.test((resolved ?? name).split(path.sep).join("/")))
        found.push(`${file.split(path.sep).join("/")}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${name}`);
      node.forEachChild(visit);
    };
    visit(source);
    return found;
  });
}

/** The package manager a package declares, or whose lock file sits in it or a directory above it, up to the repository or workspace root. */
export function packageManager(root: string): { name: string; lock?: string } {
  const locks: Record<string, string> = { "pnpm-lock.yaml": "pnpm", "bun.lock": "bun", "bun.lockb": "bun", "yarn.lock": "yarn", "package-lock.json": "npm" };
  let declared: string | undefined;
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    const pkg = manifest(dir);
    declared ??= pkg.packageManager?.split("@")[0];
    const lock = Object.keys(locks).find((f) => fs.existsSync(path.join(dir, f)));
    if (lock) return { name: declared ?? locks[lock], lock: path.join(dir, lock) };
    if (pkg.workspaces || fs.existsSync(path.join(dir, ".git")) || path.dirname(dir) === dir) return { name: declared ?? "npm" };
  }
}
