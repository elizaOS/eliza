import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { evaluatorIdentity } from "./installed.ts";
import { badSpecName, heading, type Spec } from "./parse.ts";
import type { Result } from "./pipeline.ts";
import ts from "typescript";
import { profile, type TestProfile } from "./testing/profile.ts";

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
/** A hash of several texts, in which no two lists of texts give the same input. */
export const sha = (...parts: string[]) => digest(JSON.stringify(parts));
export const short = (text: string) => digest(text).slice(0, 12);
export const indent = (s: string, by = 6) => s.split("\n").map((l) => " ".repeat(by) + l).join("\n");
/** What each promise gives, once every one has finished: a failure is thrown only then, so that nothing is left running. */
export function allDone<const T extends readonly unknown[]>(promises: T): Promise<{ -readonly [I in keyof T]: Awaited<T[I]> }>;
export async function allDone(promises: readonly unknown[]): Promise<unknown[]> {
  const settled = await Promise.allSettled(promises);
  return settled.map((r) => {
    if (r.status === "rejected") throw r.reason;
    return r.value;
  });
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

export function specOwnerPaths(root: string, name: string): string[] {
  const conventional = [`apps/${name}`, `packages/${name}`];
  const declared: unknown = manifest(root).specOwners;
  if (declared === undefined) return conventional;
  if (typeof declared !== "object" || declared === null || Array.isArray(declared)) {
    throw new Error("package.json: specOwners must map spec areas to workspace directories");
  }
  const entries: [string, unknown][] = Object.entries(declared);
  const claimed = new Set<string>();
  let match: string | undefined;
  for (const [area, dir] of entries) {
    if (badSpecName(area) || typeof dir !== "string" || !/^(?:apps|packages)\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(dir)) {
      throw new Error(`package.json: specOwners.${area} must map a spec area to a workspace directory under apps/ or packages/`);
    }
    if (claimed.has(dir)) throw new Error(`package.json: specOwners assigns ${dir} to more than one spec area`);
    claimed.add(dir);
    if (area === name) match = dir;
  }
  return match ? [match] : conventional.filter((dir) => !claimed.has(dir));
}

export function owner(root: string, spec: string): string | undefined {
  const [top, name, below] = spec.split("/");
  if (top !== "spec" || below === undefined) return undefined;
  return specOwnerPaths(root, name).find((dir) => fs.existsSync(path.join(root, dir, "package.json")) && !fs.existsSync(path.join(root, dir, "spec")));
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

/** `run()`, or what it returned the last time for the same fingerprint, if `keep` kept it then (cache.ts). */
export type Remember = <T>(fingerprint: string, run: () => Promise<T>, keep: (result: T) => boolean) => Promise<T>;

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
    for (const [dependency, version] of Object.entries({ ...pkg.peerDependencies, ...pkg.devDependencies, ...pkg.dependencies, ...pkg.optionalDependencies }).sort(([a], [b]) => a.localeCompare(b))) {
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
export function testInputs(root: string, mode: TestProfile = "normal", read: Inputs = "tests"): string | undefined {
  const evaluator = read === "tests" ? evaluatorIdentity(root) : undefined;
  if (read === "tests" && !evaluator) return undefined;
  const hash = createHash("sha256").update(JSON.stringify(["tests-v6", read, process.versions.node, process.platform, process.arch, profile(mode), ...evaluator ? [evaluator] : []]));
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
    if ([pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies, pkg.peerDependencies].some((deps) =>
      Object.values(deps ?? {}).some((version) => typeof version === "string" && version.startsWith("link:")))) return undefined;
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
export const CITATION = /(?<![\w/.-])(spec\/(?:[A-Za-z0-9]+\/)*[A-Za-z0-9]+\.md), "([^"]+)"/g;
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
export const packageCode = (root: string) => packageFiles(root, (file) => /\.(?:[cm]?[jt]sx?|vibex?)$/.test(file) && !SIDECAR.test(file));

/** A test of a package: test/**\/*.test.*, but not a driver, which the traces stage runs. */
export const isTestFile = (file: string) => /^test\/(?!drivers\/).*\.test\.[^/.]+$/.test(file);

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
