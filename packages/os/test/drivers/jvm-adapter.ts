// spec/os/appUpdate/install.md, "Story: Install an app update without running the agent mid-install"; spec/os/android/secureStore.md, "Story: Persist a value without losing a newer edit"; spec/os/browser/surface/profiles.md, "Story: Keep two sites' storage apart unless I share a profile"
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { Driver, Outcome } from "../../gen/_conformance.ts";
import { androidTools } from "../support/android-tools.ts";

export const ANSWER_WITHIN_MS = 10_000;

const PACKAGE = path.resolve(import.meta.dirname, "../..");
const SOURCE_TREES = ["android", "aosp", "test/drivers/java"] as const;
const ADAPTERS = "test/drivers/java";
const CACHE = path.join(PACKAGE, ".cache", "jvm");

type Request =
  | { readonly kind: "reset" }
  | { readonly kind: "event"; readonly event: unknown; readonly by?: unknown }
  | { readonly kind: "raw"; readonly raw: unknown; readonly by?: unknown };

type Answer =
  | { readonly kind: "state"; readonly state: unknown; readonly out?: unknown }
  | { readonly kind: "stepped"; readonly outcome: Outcome; readonly state: unknown; readonly out?: unknown };

interface Session {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ask: (request: Request) => Promise<Answer>;
  state: unknown;
  out: unknown;
}

export interface JvmOptions {
  readonly receives?: boolean;
}

const javaTool = (name: "java" | "javac") => process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;

const javaFiles = (directory: string): string[] => existsSync(directory)
  ? readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".java") && !/(?:^|\/)(?:build|\.gradle)\//.test(path.relative(PACKAGE, entry.parentPath)))
    .map((entry) => path.join(entry.parentPath, entry.name))
  : [];

function sourceRoot(file: string, text: string): string {
  const declared = /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1];
  const directory = path.dirname(file);
  if (declared === undefined) return directory;
  const suffix = path.join(...declared.split("."));
  return directory.endsWith(`${path.sep}${suffix}`) ? directory.slice(0, -suffix.length - 1) : directory;
}

interface Sources {
  readonly digest: string;
  readonly roots: readonly string[];
  readonly adapters: ReadonlyMap<string, string>;
}

function sources(): Sources {
  const files = SOURCE_TREES.flatMap((tree) => javaFiles(path.join(PACKAGE, tree))).sort();
  const digest = createHash("sha256");
  const roots = new Set<string>();
  const adapters = new Map<string, string>();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    digest.update(`${path.relative(PACKAGE, file)}\0${text}\0`);
    const root = sourceRoot(file, text);
    roots.add(root);
    if (file.startsWith(path.join(PACKAGE, ADAPTERS) + path.sep) && /\bpublic\s+static\s+void\s+main\s*\(/.test(text))
      adapters.set(path.relative(root, file).slice(0, -".java".length).split(path.sep).join("."), file);
  }
  return { digest: digest.digest("hex").slice(0, 24), roots: [...roots], adapters };
}

export function compileAdapter(main: string, found: Sources = sources()): string {
  const adapter = found.adapters.get(main);
  if (adapter === undefined) throw new Error(`no JVM adapter ${main} under ${ADAPTERS}`);
  const classes = path.join(CACHE, `${found.digest}-${main}`);
  if (existsSync(classes)) return classes;
  const tools = androidTools();
  mkdirSync(CACHE, { recursive: true });
  const staging = mkdtempSync(path.join(CACHE, ".compiling-"));
  try {
    execFileSync(javaTool("javac"), [
      "--release", "21", "-encoding", "UTF-8", "-nowarn", "-implicit:class", "-d", staging,
      ...(tools.kind === "present" ? ["-classpath", tools.androidJar] : []),
      "-sourcepath", found.roots.join(path.delimiter), adapter,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    renameSync(staging, classes);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (existsSync(classes)) return classes;
    const stderr = (error as { stderr?: Buffer }).stderr?.toString("utf8") ?? "";
    throw new Error(`javac could not compile ${main}:\n${stderr || String(error)}`, { cause: error });
  }
  return classes;
}

export function compileAdapters(): { readonly compiled: readonly string[]; readonly failed: readonly string[] } {
  const found = sources();
  const compiled: string[] = [];
  const failed: string[] = [];
  for (const main of found.adapters.keys()) {
    try {
      compiled.push(compileAdapter(main, found));
    } catch (error) {
      failed.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { compiled, failed };
}

function parseAnswer(line: string, request: Request): Answer {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`the JVM adapter answered ${line} to ${JSON.stringify(request)}`);
  const record = value as Record<string, unknown>;
  if (typeof record.error === "string") throw new Error(`the JVM adapter failed on ${JSON.stringify(request)}: ${record.error}`);
  if (!Object.hasOwn(record, "state")) throw new Error(`the JVM adapter answered without a state to ${JSON.stringify(request)}`);
  const out = Object.hasOwn(record, "out") ? { out: record.out } : {};
  switch (request.kind) {
    case "reset": return { kind: "state", state: record.state, ...out };
    case "event":
    case "raw":
      if (record.outcome !== "accepted" && record.outcome !== "refused") throw new Error(`the JVM adapter answered ${JSON.stringify(request)} without "accepted" or "refused"`);
      return { kind: "stepped", outcome: record.outcome, state: record.state, ...out };
    default: {
      const exhausted: never = request;
      return exhausted;
    }
  }
}

const wire = (request: Request) => {
  switch (request.kind) {
    case "reset": return {};
    case "event": return request.by === undefined ? { event: request.event } : { event: request.event, by: request.by };
    case "raw": return request.by === undefined ? { raw: request.raw } : { raw: request.raw, by: request.by };
    default: {
      const exhausted: never = request;
      return exhausted;
    }
  }
};

async function start(classes: string, main: string): Promise<Session> {
  const child = spawn(javaTool("java"), ["-Xshare:auto", "-XX:TieredStopAtLevel=1", "-cp", classes, main], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString("utf8")).slice(-16_384); });
  child.stdin.on("error", () => {});
  const answers = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const ask = async (request: Request): Promise<Answer> => {
    child.stdin.write(`${JSON.stringify(wire(request))}\n`);
    let timer: NodeJS.Timeout | undefined;
    const next = await Promise.race([answers.next(), new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ANSWER_WITHIN_MS); })]);
    clearTimeout(timer);
    if (next === undefined) throw new Error(`${main} did not answer ${JSON.stringify(request)} within ${ANSWER_WITHIN_MS / 1000} seconds${stderr ? `; stderr: ${stderr}` : ""}`);
    if (next.done) throw new Error(`${main} ended without answering ${JSON.stringify(request)}${stderr ? `; stderr: ${stderr}` : ""}`);
    return parseAnswer(next.value, request);
  };
  const initial = await ask({ kind: "reset" });
  return { child, ask, state: initial.state, out: initial.out };
}

export function jvmDriver<E, V>(main: string, options: JvmOptions = {}): Driver<E, V> & AsyncDisposable {
  const sessions = new Map<string, Promise<Session>>();
  let classes: string | undefined;
  const session = (key: string) => {
    const existing = sessions.get(key);
    if (existing) return existing;
    const started = start(classes ??= compileAdapter(main), main);
    sessions.set(key, started);
    return started;
  };
  const step = async (key: string, request: Extract<Request, { kind: "event" | "raw" }>): Promise<Outcome> => {
    const held = await session(key);
    const answer = await held.ask(request);
    if (answer.kind !== "stepped") throw new Error(`${main} answered a step with a bare state`);
    held.state = answer.state;
    held.out = answer.out;
    return answer.outcome;
  };
  const driver: Driver<E, V> & AsyncDisposable = {
    reset: async () => {
      for (const started of sessions.values()) {
        const held = await started;
        const answer = await held.ask({ kind: "reset" });
        held.state = answer.state;
        held.out = answer.out;
      }
    },
    dispatch: (key, event, by) => step(key, { kind: "event", event, by }),
    observe: async (key) => (await session(key)).state as V,
    observeOutput: async (key) => (await session(key)).out,
    [Symbol.asyncDispose]: async () => {
      for (const started of sessions.values()) (await started).child.kill();
      sessions.clear();
    },
  };
  return options.receives ? { ...driver, receive: (key, raw, by) => step(key, { kind: "raw", raw, by }) } : driver;
}

if (import.meta.main && process.argv.includes("--compile")) {
  const { compiled, failed } = compileAdapters();
  process.stdout.write(`${JSON.stringify({ compiled: compiled.map((classes) => path.relative(PACKAGE, classes)), failed: failed.length }, null, 2)}\n`);
  for (const failure of failed) process.stderr.write(`${failure}\n`);
  process.exitCode = failed.length ? 1 : 0;
}
