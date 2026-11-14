// What Studio reads of a project, through the tools' own synchronous API (../../spec.ts, ../../parse.ts), and the
// Node edges Effect has no service for. Everything that runs, writes or serves is ./server.vibe's.
// README, "Studio".
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { trusted } from "vibelang-runtime";
import { acceptable, type Result } from "../../spec.ts";
import { parseSpec, readSpecs, specFiles, specName } from "../../parse.ts";
import { ledgerFile, pending, pendingKey, type Lock } from "../../review.ts";
import { filesUnder, projectRoot, short } from "../../util.ts";
import type { Session, Verdict } from "../gen/index.ts";
import { manifestOf, nodesOf, type Ids, type Manifest } from "./doc.ts";
import { outlineOf, specOrder } from "./markdown.ts";
import type { ComponentIndex } from "./catalog.ts";

const EXT = path.extname(import.meta.filename);
/** The tools: vibestack/ from source, dist/ when built. */
export const TOOLS = path.join(import.meta.dirname, "..", "..");
/** The `spec` command, as source or as built. */
export const SPEC = path.join(TOOLS, `spec${EXT}`);
/** The page, as built by ../vite.config.ts. */
export const PUBLIC = path.join(import.meta.dirname, "..", "dist", "page");
/** This Node, to run the `spec` command with. */
export const NODE = process.execPath;

/** @throws {never} */
export const createServer = () => http.createServer();
/** The directory and arguments `spec studio` was started with (../../spec.ts). @throws {never} */
export const commandLine = () => ({ cwd: process.cwd(), args: process.argv.slice(2) });
/** @throws {never} */
export const interactive = () => process.stdout.isTTY === true;
/** The program that opens a URL in the browser. @throws {never} */
export const opener = () => (process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open");
/** The program that says whether another is on the PATH. @throws {never} */
export const finder = () => (process.platform === "win32" ? "where" : "which");

const readJson = <T>(file: string): T | undefined => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined);
/** The project's name in its package.json, or its directory's. A trusted call: VibeLang code receives its `Error`s as failures. */
export const projectName = trusted((root: string) => readJson<{ name?: string }>(path.join(root, "package.json"))?.name ?? path.basename(root), [Error]);
/** What the last publish left for an agent to sync. A trusted call. */
export const readManifest = trusted((root: string) => readJson<Manifest>(manifestFile(root)), [Error]);
/** @throws {never} */
export const stateFile = (root: string) => path.join(root, ".studio", "state.json");
/** @throws {never} */
export const manifestFile = (root: string) => path.join(root, ".studio", "manifest.json");

/**
 * The script that runs the project's app (spec/index.md, "The app can be started and stopped whenever, beside any job"):
 * `start`, or `dev` when that is not the studio; undefined when there is none. A trusted call.
 */
export const appScript = trusted(function appScript(root: string): string | undefined {
  const scripts = readJson<{ scripts?: Record<string, string> }>(path.join(root, "package.json"))?.scripts ?? {};
  return scripts.start ? "start" : scripts.dev && !/\bspec(\.ts)? studio\b/.test(scripts.dev) ? "dev" : undefined;
}, [Error]);

/** A terminal colour code, which development servers print around their address. */
const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
/** Whether the project can be built: it has a `build` script (spec/index.md, "The app is built from published specs, when no job runs"). A trusted call. */
export const buildable = trusted((root: string) => buildCommand(root) !== undefined, [Error]);

/**
 * How the project is built (spec/index.md, "The app is built from published specs, when no job runs"): at a workspace
 * root, every app under `apps/` that has a `build` script; elsewhere, the project's own `build` script. A trusted call.
 */
export const buildCommand = trusted(function buildCommand(root: string): [string, string[]] | undefined {
  const scripts = (dir: string) => readJson<{ scripts?: Record<string, string> }>(path.join(dir, "package.json"))?.scripts ?? {};
  const apps = path.join(root, "apps");
  const workspaceApps = fs.existsSync(path.join(root, "pnpm-workspace.yaml")) && fs.existsSync(apps)
    && fs.readdirSync(apps).some((name) => scripts(path.join(apps, name)).build);
  return workspaceApps ? ["pnpm", ["--filter", "./apps/*", "run", "build"]] : scripts(root).build ? ["pnpm", ["run", "build"]] : undefined;
}, [Error]);

/** The address a development server says it serves at, in a line it printed. @throws {never} */
export const servedAt = (line: string) => line.replace(COLOUR, "").match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+[^\s]*/)?.[0];

/** `spec studio [<directory>]`'s project: the directory, which must hold a spec tree. A trusted call. */
export const studioRoot = trusted(function studioRoot(cwd: string, directory: string): string {
  const root = projectRoot(directory, cwd);
  if (!fs.statSync(path.join(root, "spec"), { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${root}: no spec/ directory; run \`spec init\` in the project first`);
  return root;
}, [Error]);

/** Every Markdown spec in the tree, by its path from the project root. A trusted call. */
export const specTexts = trusted(function specTexts(root: string): Record<string, string> {
  return Object.fromEntries(specFiles(root).map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]));
}, [Error]);

/** The command a person or agent runs in a project to check it: its own script if it can, else the tools of this repository. A trusted call. */
export const checkCommand = trusted(function checkCommand(root: string): string {
  const scripts = readJson<{ scripts?: Record<string, string> }>(path.join(root, "package.json"))?.scripts ?? {};
  const hasSpecBin = fs.existsSync(path.join(root, "node_modules/.bin/spec")) || !scripts.check?.startsWith("spec ");
  return scripts.check && hasSpecBin ? "pnpm check" : `node ${path.relative(root, SPEC)} check`;
}, [Error]);

/** The sync skill, as a path from the project root: its own copy, or the nearest one above it. @throws {never} */
export function skillPath(root: string): string {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const file = path.join(dir, ".claude/skills/sync/SKILL.md");
    if (fs.existsSync(file)) return path.relative(root, file);
    if (dir === path.dirname(dir)) return ".claude/skills/sync/SKILL.md";
  }
}

/** The review ledger (../../review.ts, `ledgerFile`) and Studio's state belong to the tools, not the sync agent. A trusted call. */
export const ownedFiles = trusted(function ownedFiles(root: string): Record<string, string> {
  const ledger = path.relative(root, ledgerFile(root));
  return Object.fromEntries([...(fs.existsSync(path.join(root, ledger)) ? [ledger] : []), ...filesUnder(root, ".studio")]
    .map((f) => [f, short(fs.readFileSync(path.join(root, f), "utf8"))]));
}, [Error]);

/**
 * What a check found, as spec/index.md's verdict. `Reviewable` is what `accept` can record: every stage but review
 * passed, every story has rules and every rule has Quint. @throws {never}
 */
export function verdictOf(results: Result[]): Verdict {
  return !results.some((r) => !r.ok) ? "Green" : acceptable(results) ? "Reviewable" : "Failing";
}

/** The specs as the page shows them, with what the review ledger says of each story and rule. A trusted call. */
export const specsOf = trusted(function specsOf(root: string) {
  const texts = specTexts(root);
  const specs = readSpecs(root);
  const locks = new Map<string, Lock>();
  const review = Object.fromEntries(specs.map((s) => [s.file, Object.fromEntries(pending(root, s, specs, locks).map((p) => [pendingKey(p), p.status + (p.note ?? "")]))]));
  return Object.entries(texts).sort(([a], [b]) => specOrder(a, b))
    .map(([file, text]) => ({ file, module: specName(file), hash: short(text), text, outline: outlineOf(file, text), review: review[file] ?? {} }));
}, [Error]);

/**
 * The page, built: from a source checkout, Vite builds it again when anything it is built from is newer than the
 * build; a packaged studio ships it built.
 */
export async function buildPage(): Promise<void> {
  if (EXT !== ".ts") return;
  const studio = path.join(import.meta.dirname, "..");
  const built = fs.statSync(path.join(PUBLIC, "index.html"), { throwIfNoEntry: false })?.mtimeMs ?? 0;
  const newest = (dir: string): number => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => e.name === "node_modules" ? n
    : Math.max(n, e.isDirectory() ? newest(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).mtimeMs), 0);
  const inputs = [path.join(studio, "src"), path.join(studio, "gen"), path.join(studio, "vite.config.ts"), path.join(TOOLS, "design"),
    path.dirname(fileURLToPath(import.meta.resolve("@repo/ui"))), fileURLToPath(import.meta.resolve("@repo/design-system/tokens.json"))];
  if (inputs.every((f) => (fs.statSync(f).isDirectory() ? newest(f) : fs.statSync(f).mtimeMs) < built)) return;
  const { build } = await import("vite");
  await build({ configFile: path.join(studio, "vite.config.ts") });
}

/**
 * The component catalogs `vibestack/stories/cli.ts gen` wrote in the project and in its workspace packages, as one,
 * each source path from the project root; undefined when there are none. A trusted call.
 */
export const componentsOf = trusted(function componentsOf(root: string): ComponentIndex | undefined {
  const dirs = [".", ...["apps", "packages"].flatMap((d) => (fs.existsSync(path.join(root, d)) ? fs.readdirSync(path.join(root, d)).map((n) => `${d}/${n}`) : []))];
  const found = dirs.flatMap((dir) => {
    const index = readJson<ComponentIndex>(path.join(root, dir, "generated/stories/catalog.json"));
    return index ? [{ dir, index }] : [];
  });
  if (!found.length) return undefined;
  return {
    version: 1,
    storybook: { url: found.find((f) => f.index.storybook.url)?.index.storybook.url },
    // A component catalogued both in the project and in its package is shown once.
    components: [...new Map(found.flatMap(({ dir, index }) => index.components.map((c) => {
      const file = path.posix.join(dir, c.source.file);
      return [`${file}#${c.name}`, { ...c, source: { ...c.source, file } }] as const;
    }))).values()],
  };
}, [Error]);

/** A job as the page sees it: what ran, how it ended, and the last of what it printed. */
export interface JobView { label: string; status: "running" | "passed" | "failed" | "stopped"; started: number; finished?: number; log: string[] }
/** The last check's report, and when it finished. */
export interface Check { ok: boolean; results: Result[]; next: string; finished: number }
/** Everything the page (./page/) shows for a project, as ./server.vibe answers `GET /api/project`. */
export interface Snapshot {
  project: { id: string; name: string; root: string };
  session: Session;
  specs: ReturnType<typeof specsOf>;
  problem?: string;
  manifest?: Manifest;
  prompt: string;
  check?: Check;
  jobs: Partial<Record<"check" | "agent" | "accept" | "build", JobView>>;
  agents: { id: string; label: string; available: boolean; link?: string }[];
  /**
   * The project's app: the script that runs it, where it serves once it says so, the last of what it printed, and
   * whether it has a `build` script to build it with.
   */
  app: { script?: string; url?: string; log: string[]; buildable: boolean };
}

/** What the page asks to publish: each file as it was loaded (`base`, a hash) and as it is now (`text`, null to delete). */
export interface Publish { files: { file: string; base: string | null; text: string | null }[]; origins: [string, string | null][]; force?: boolean }
interface State { baseline: Record<string, string>; ids: Ids }
/** What publishing writes, or why it may not. */
export type Plan =
  | { status: 400 | 409; body: { error: string; conflicts?: string[] } }
  | { status: 200; disk: Record<string, string>; state: State; manifest: Manifest };

/**
 * Check a publish against the project, and work out the manifest it leaves: the baseline the agent last synced, and
 * where each story and rule came from. A trusted call. */
export const planPublish = trusted(function planPublish(root: string, body: Publish): Plan {
  // Nothing but a spec is written or deleted, whatever the page sends.
  const outside = body.files.find((f) => typeof f.file !== "string" || !/^spec\/.+\.md$/.test(f.file));
  if (outside) return { status: 400, body: { error: `${String(outside.file)}: a spec lives under spec/ and ends in .md` } };
  const disk = specTexts(root);
  const conflicts = body.force ? [] : body.files.filter((f) => (f.file in disk ? short(disk[f.file]) : null) !== f.base).map((f) => f.file);
  if (conflicts.length) return { status: 409, body: { error: "changed on disk since you loaded it", conflicts } };
  const next = { ...disk };
  for (const f of body.files) {
    try {
      specName(f.file);
      let target = root;
      for (const segment of f.file.split("/")) {
        target = path.join(target, segment);
        if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${f.file}: spec paths may not be symlinks`);
      }
      if (f.text !== null) parseSpec(root, f.file, f.text);
    } catch (e) { return { status: 400, body: { error: (e as Error).message } }; }
    if (f.text === null) delete next[f.file];
    else next[f.file] = f.text;
  }
  // Every heading the page meant to write is a heading of the text: a prose line that starts with ## would not be.
  const origins = new Map(body.origins);
  for (const f of body.files) if (f.text !== null) {
    const stray = nodesOf(f.file, f.text).find((n) => !origins.has(n.id));
    if (stray) return { status: 400, body: { error: `${f.file}: "${stray.heading}" would be a heading; a line of prose may not start with ## or ###` } };
  }
  const state = readJson<State>(stateFile(root)) ?? { baseline: disk, ids: {} };
  const inBaseline = new Set(Object.entries(state.baseline).flatMap(([f, t]) => nodesOf(f, t).map((n) => n.id)));
  const baseOf = (id: string) => (id in state.ids ? state.ids[id] : inBaseline.has(id) ? id : null);
  const ids: Ids = {};
  for (const [file, text] of Object.entries(next)) for (const n of nodesOf(file, text)) {
    const origin = body.files.some((f) => f.file === file) ? origins.get(n.id) ?? null : n.id;
    ids[n.id] = origin === null ? null : baseOf(origin);
  }
  return { status: 200, disk, state: { baseline: state.baseline, ids }, manifest: manifestOf(root, state.baseline, next, ids) };
}, [Error]);
