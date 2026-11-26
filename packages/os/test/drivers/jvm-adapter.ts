// spec/os/appUpdate/install.md, "Story: Install an app update without running the agent mid-install"; spec/os/android/secureStore.md, "Story: Persist a value without losing a newer edit"; spec/os/browser/surface/profiles.md, "Story: Keep two sites' storage apart unless I share a profile"
import { type ChildProcessWithoutNullStreams, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { accessSync, constants, existsSync, globSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Driver, Outcome } from "../../gen/_conformance.ts";
import { androidTools } from "../support/android-tools.ts";

export const ANSWER_WITHIN_MS = 10_000;

const PACKAGE = path.resolve(import.meta.dirname, "../..");
const SOURCE_TREES = ["android", "aosp", "test/drivers/java"] as const;
const ADAPTERS = "test/drivers/java";
const CACHE = path.join(PACKAGE, ".cache", "jvm");
const ARRANGED = path.join(CACHE, "sources");

const JSON_JAVA_SHA256 = "3ea61b2a06e31edf1c91134fe9106b0ebb16628be169f3db75bc7a2b06b45796";
const JSON_JAVA_URL = "https://repo.maven.apache.org/maven2/org/json/json/20250517/json-20250517.jar";

const verifiedJsonJava = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex") === JSON_JAVA_SHA256;

function gradleJsonJava(filename: string): Uint8Array | undefined {
  const home = process.env.GRADLE_USER_HOME || path.join(homedir(), ".gradle");
  const directory = path.join(home, "caches/modules-2/files-2.1/org.json/json/20250517");
  for (const candidate of globSync(`*/${filename}`, { cwd: directory })) {
    const bytes = readFileSync(path.join(directory, candidate));
    if (verifiedJsonJava(bytes)) return bytes;
  }
  return undefined;
}

async function downloadJsonJava(): Promise<Uint8Array> {
  const response = await fetch(JSON_JAVA_URL, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`JSON-java download failed (HTTP ${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!verifiedJsonJava(bytes)) throw new Error("JSON-java 20250517 did not match its pinned SHA-256");
  return bytes;
}

async function resolveJsonJava(): Promise<string> {
  const artifact = path.join(CACHE, "json-20250517.jar");
  if (existsSync(artifact) && verifiedJsonJava(readFileSync(artifact))) return artifact;
  const bytes = gradleJsonJava(path.basename(artifact)) ?? await downloadJsonJava();
  mkdirSync(CACHE, { recursive: true });
  const staging = mkdtempSync(path.join(CACHE, ".json-java-"));
  try {
    const temporary = path.join(staging, path.basename(artifact));
    writeFileSync(temporary, bytes);
    renameSync(temporary, artifact);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return artifact;
}

let jsonJava: Promise<string> | undefined;
export const jsonJavaArtifact = () => jsonJava ??= resolveJsonJava().finally(() => { jsonJava = undefined; });

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
  readonly recreateAfter?: (event: unknown) => boolean;
}

const javaTool = (name: "java" | "javac") => process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;

const javaFiles = (directory: string): string[] => existsSync(directory)
  ? readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".java") && !/(?:^|\/)(?:build|\.gradle)\//.test(path.relative(PACKAGE, entry.parentPath)))
    .map((entry) => path.join(entry.parentPath, entry.name))
  : [];

function sourceRoot(file: string, text: string) {
  const declared = /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1];
  const directory = path.dirname(file);
  if (declared === undefined) return { root: directory };
  const suffix = path.join(...declared.split("."));
  if (directory.endsWith(`${path.sep}${suffix}`)) return { root: directory.slice(0, -suffix.length - 1) };
  const root = path.join(ARRANGED, path.relative(PACKAGE, directory), "source-root");
  return { root, placed: path.join(root, suffix, path.basename(file)) };
}

interface Sources {
  readonly digest: string;
  readonly roots: readonly string[];
  readonly arranged: ReadonlyMap<string, Buffer>;
  readonly adapters: ReadonlyMap<string, string>;
}

function sources(trees: readonly string[] = SOURCE_TREES, adapterTrees: readonly string[] = [ADAPTERS]): Sources {
  const files = trees.flatMap((tree) => javaFiles(path.join(PACKAGE, tree))).sort();
  const digest = createHash("sha256");
  const roots = new Set<string>();
  const arranged = new Map<string, Buffer>();
  const adapters = new Map<string, string>();
  for (const file of files) {
    const bytes = readFileSync(file);
    const text = bytes.toString("utf8");
    digest.update(`${path.relative(PACKAGE, file)}\0${bytes.length}\0`).update(bytes);
    const { root, placed } = sourceRoot(file, text);
    roots.add(root);
    if (placed !== undefined) arranged.set(placed, bytes);
    if (adapterTrees.some((tree) => file.startsWith(path.join(PACKAGE, tree) + path.sep)) && /\bpublic\s+static\s+void\s+main\s*\(/.test(text))
      adapters.set(path.relative(root, placed ?? file).slice(0, -".java".length).split(path.sep).join("."), file);
  }
  return { digest: digest.digest("hex").slice(0, 24), roots: [...roots], arranged, adapters };
}

function arrangedTree(found: Sources) {
  let staged: { readonly directory: string; readonly roots: readonly string[] } | undefined;
  return {
    open: () => {
      if (found.arranged.size === 0) return found.roots;
      if (staged !== undefined) return staged.roots;
      const directory = mkdtempSync(path.join(CACHE, ".sources-"));
      try {
        for (const [placed, bytes] of found.arranged) {
          const destination = path.join(directory, path.relative(ARRANGED, placed));
          mkdirSync(path.dirname(destination), { recursive: true });
          writeFileSync(destination, bytes);
        }
        const roots = found.roots.map((root) =>
          root.startsWith(ARRANGED + path.sep) ? path.join(directory, path.relative(ARRANGED, root)) : root);
        staged = { directory, roots };
        return roots;
      } catch (error) {
        rmSync(directory, { recursive: true, force: true });
        throw error;
      }
    },
    close() {
      if (staged !== undefined) rmSync(staged.directory, { recursive: true, force: true });
    },
  };
}

interface FileStamp {
  readonly file: string;
  readonly stamp: string;
}

interface JarIdentity extends FileStamp {
  readonly digest: string;
  readonly selfContained: boolean;
}

const jarIdentities = new Map<string, JarIdentity>();

function fileStamp(file: string): string {
  const stat = statSync(file, { bigint: true, throwIfNoEntry: false });
  return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : "missing";
}

function identifyJar(file: string): JarIdentity {
  const stamp = fileStamp(file);
  const cached = jarIdentities.get(file);
  if (cached?.stamp === stamp) return cached;
  const bytes = readFileSync(file);
  const digest = createHash("sha256").update(bytes).digest("hex");
  let selfContained = digest === JSON_JAVA_SHA256;
  if (!selfContained && !bytes.includes("META-INF/services/") && !bytes.includes("META-INF/INDEX.LIST")) {
    const manifest = spawnSync("/usr/bin/unzip", ["-p", "-C", path.resolve(file), "META-INF/MANIFEST.MF"], { encoding: "utf8", env: {} });
    selfContained = manifest.status === 11 || (manifest.status === 0 && !/^Class-Path:/im.test(manifest.stdout));
  }
  const identity = { file, stamp, digest, selfContained };
  assertInputs([identity]);
  jarIdentities.set(file, identity);
  return identity;
}

function assertInputs(inputs: readonly FileStamp[]) {
  for (const { file, stamp } of inputs)
    if (fileStamp(file) !== stamp) throw new Error(`JVM compiler input changed while using ${file}`);
}

function compilerInputs() {
  const name = process.platform === "win32" ? "javac.exe" : "javac";
  const candidates = process.env.JAVA_HOME
    ? [path.join(process.env.JAVA_HOME, "bin", name)]
    : (process.env.PATH ?? "").split(path.delimiter).map((directory) => path.resolve(directory, name));
  const launcher = candidates.find((file) => {
    try { accessSync(file, constants.X_OK); return statSync(file).isFile(); }
    catch { return false; }
  });
  if (!launcher) throw new Error("javac is required to compile or reuse JVM fixtures");
  const compiler = realpathSync(launcher);
  let home = path.dirname(path.dirname(compiler));
  let command = launcher;
  if (process.platform === "darwin" && compiler === "/usr/bin/javac") {
    home = execFileSync("/usr/libexec/java_home", { encoding: "utf8" }).trim();
    command = path.join(home, "bin", name);
  }
  const files = [
    command,
    path.join(home, "bin", name),
    path.join(home, "release"),
    path.join(home, "lib", "modules"),
    path.join(home, "lib", "ct.sym"),
  ];
  const inputs = files.map((file) => ({ file, stamp: fileStamp(file) }));
  const stockLauncher = existsSync(path.join(home, "lib", "modules")) && existsSync(path.join(home, "bin", name))
    && realpathSync(command) === realpathSync(path.join(home, "bin", name))
    && !readFileSync(command).subarray(0, 2).equals(Buffer.from("#!"));
  return { command, stockLauncher, inputs };
}

function compiledClasses(directory: string): string | undefined {
  const digest = createHash("sha256");
  for (const relative of readdirSync(directory, { recursive: true, encoding: "utf8" }).sort()) {
    const file = path.join(directory, relative);
    const stat = lstatSync(file);
    digest.update(JSON.stringify([relative, stat.mode]));
    if (stat.isFile()) {
      const bytes = readFileSync(file);
      digest.update(JSON.stringify(bytes.length)).update(bytes);
    } else if (stat.isSymbolicLink()) throw new Error(`javac output contains a symbolic link: ${relative}`);
    else if (!stat.isDirectory()) return undefined;
  }
  return path.join(CACHE, `compiled-${digest.digest("hex")}`);
}

export function compileAdapter(main: string, found: Sources = sources(), dependencies: readonly string[] = []): string {
  const tree = arrangedTree(found);
  try {
    return compile(main, found, dependencies, tree.open);
  } finally {
    tree.close();
  }
}

function compile(main: string, found: Sources, dependencies: readonly string[], roots: () => readonly string[]): string {
  const adapter = found.adapters.get(main);
  if (adapter === undefined) throw new Error(`no JVM adapter ${main} under ${ADAPTERS}`);
  const tools = androidTools();
  const classpath = [...dependencies, ...(tools.kind === "present" ? [tools.androidJar] : [])];
  const jars = classpath.map(identifyJar);
  const compiler = compilerInputs();
  const inputs = [...compiler.inputs, ...jars];
  const options = [process.env.JDK_JAVAC_OPTIONS, process.env.JAVA_TOOL_OPTIONS, process.env._JAVA_OPTIONS];
  const external = options.some(Boolean) || process.env.JDK_ALTERNATE_VM
    || Object.entries(process.env).some(([name, value]) => value && (name.endsWith("JAVA_OPTIONS") || /^(LD_|DYLD_)/.test(name)));
  const key = [compiler.inputs.map((input) => input.stamp), jars.map((jar) => jar.digest), ...options];
  const dependencyKey = createHash("sha256").update(JSON.stringify(key)).digest("hex");
  const classes = !external && compiler.stockLauncher && jars.every((jar) => jar.selfContained)
    ? path.join(CACHE, `arranged-sources-v1-${found.digest}-${main}-${dependencyKey}`) : undefined;
  if (classes && existsSync(classes)) {
    assertInputs(inputs);
    return classes;
  }
  mkdirSync(CACHE, { recursive: true });
  const staging = mkdtempSync(path.join(CACHE, ".compiling-"));
  let published: string | undefined;
  try {
    execFileSync(compiler.command, [
      "--release", "21", "-encoding", "UTF-8", "-nowarn", "-implicit:class", "-d", staging,
      "-classpath", classpath.length ? classpath.join(path.delimiter) : staging,
      "-sourcepath", roots().join(path.delimiter), adapter,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    assertInputs(inputs);
    published = classes ?? compiledClasses(staging);
    if (!published) return staging;
    renameSync(staging, published);
    return published;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    assertInputs(inputs);
    if (published && existsSync(published)) return published;
    const stderr = (error as { stderr?: Buffer }).stderr?.toString("utf8") ?? "";
    throw new Error(`javac could not compile ${main}:\n${stderr || String(error)}`, { cause: error });
  }
}

export async function orgJsonAdapterClasspath(main: string, trees?: readonly string[]): Promise<string> {
  const jar = await jsonJavaArtifact();
  return [compileAdapter(main, trees === undefined ? undefined : sources(trees, trees), [jar]), jar].join(path.delimiter);
}

const needsOrgJson = (main: string) =>
  main.startsWith("ai.eliza.plugins.media.") || main.startsWith("ai.eliza.plugins.actionjournal.") || main.startsWith("ai.eliza.plugins.notifications.") || main === "ai.eliza.plugins.signin.ReadinessJourney" || main === "ai.eliza.plugins.signin.DeviceKeyJourney" || main === "ai.eliza.plugins.browsersurface.SessionRecordJourney" || main === "ai.eliza.systemupdater.JournalReplay" || main === "ai.eliza.files.StorageBrowsingCheck";

export async function compileAdapters(): Promise<{ readonly compiled: readonly string[]; readonly failed: readonly string[] }> {
  const found = sources();
  const tree = arrangedTree(found);
  const compiled: string[] = [];
  const failed: string[] = [];
  try {
    for (const main of found.adapters.keys()) {
      try {
        compiled.push(compile(main, found, needsOrgJson(main) ? [await jsonJavaArtifact()] : [], tree.open));
      } catch (error) {
        failed.push(error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    tree.close();
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

async function start(classes: string, main: string, args: string[]): Promise<Session> {
  const child = spawn(javaTool("java"), ["-Xshare:auto", "-XX:TieredStopAtLevel=1", "-cp", classes, main, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString("utf8")).slice(-16_384); });
  child.stdin.on("error", () => {});
  const answers = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const ask = async (request: Request): Promise<Answer> => {
    child.stdin.write(`${JSON.stringify(wire(request))}\n`);
    const next = await Promise.race([answers.next(), once(AbortSignal.timeout(ANSWER_WITHIN_MS), "abort").then(() => undefined)]);
    if (next === undefined) throw new Error(`${main} did not answer ${JSON.stringify(request)} within ${ANSWER_WITHIN_MS / 1000} seconds${stderr ? `; stderr: ${stderr}` : ""}`);
    if (next.done) throw new Error(`${main} ended without answering ${JSON.stringify(request)}${stderr ? `; stderr: ${stderr}` : ""}`);
    return parseAnswer(next.value, request);
  };
  try {
    const initial = await ask({ kind: "reset" });
    return { child, ask, state: initial.state, out: initial.out };
  } catch (error) {
    child.kill();
    throw error;
  }
}

async function retire(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit", { signal: AbortSignal.timeout(ANSWER_WITHIN_MS) });
    child.stdin.end();
    try { await exited; }
    catch (error) {
      child.kill("SIGKILL");
      throw error;
    }
  }
  if (child.exitCode !== 0) throw new Error("The JVM adapter did not exit cleanly");
}

export function jvmDriver<E, V>(main: string, options: JvmOptions = {}): Driver<E, V> & AsyncDisposable {
  const sessions = new Map<string, Promise<Session>>();
  const fixtures = new Map<string, string>();
  let classes: string | undefined;
  const open = async (key: string, mode: "fresh" | "reopen") => {
    const args: string[] = [];
    if (options.recreateAfter) {
      const fixture = fixtures.get(key) ?? mkdtempSync(path.join(tmpdir(), "eliza-jvm-driver-"));
      fixtures.set(key, fixture);
      args.push(fixture, mode);
    }
    classes ??= needsOrgJson(main) ? await orgJsonAdapterClasspath(main) : compileAdapter(main);
    return start(classes, main, args);
  };
  const session = (key: string) => {
    const existing = sessions.get(key);
    if (existing) return existing;
    const started = open(key, "fresh");
    sessions.set(key, started);
    return started;
  };
  const step = async (key: string, request: Extract<Request, { kind: "event" | "raw" }>): Promise<Outcome> => {
    const held = await session(key);
    const answer = await held.ask(request);
    if (answer.kind !== "stepped") throw new Error(`${main} answered a step with a bare state`);
    held.state = answer.state;
    held.out = answer.out;
    if (answer.outcome === "accepted" && options.recreateAfter?.(request.kind === "event" ? request.event : request.raw)) {
      const reopened = retire(held.child).then(() => open(key, "reopen"));
      sessions.set(key, reopened);
      await reopened;
    }
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
      try {
        for (const started of sessions.values()) {
          const { child } = await started;
          if (options.recreateAfter) await retire(child);
          else child.kill();
        }
      } finally {
        for (const fixture of fixtures.values()) rmSync(fixture, { recursive: true, force: true });
        fixtures.clear();
        sessions.clear();
      }
    },
  };
  return options.receives ? { ...driver, receive: (key, raw, by) => step(key, { kind: "raw", raw, by }) } : driver;
}

if (import.meta.main && process.argv.includes("--compile")) {
  const { compiled, failed } = await compileAdapters();
  process.stdout.write(`${JSON.stringify({ compiled: compiled.map((classes) => path.relative(PACKAGE, classes)), failed: failed.length }, null, 2)}\n`);
  for (const failure of failed) process.stderr.write(`${failure}\n`);
  process.exitCode = failed.length ? 1 : 0;
}

interface LineDriver<E> {
  reset(): unknown;
  dispatch(key: string, event: E): unknown;
  observe(key: string): unknown;
  [Symbol.asyncDispose](): PromiseLike<void>;
}

export async function answerDriverLines<E>(driver: LineDriver<E>, key: string, output: (key: string) => unknown, withOutcome = false): Promise<void> {
  const answer = async (line: string) => {
    const request: unknown = JSON.parse(line);
    if (typeof request !== "object" || request === null || Array.isArray(request)) throw new Error(`not a driver request: ${line}`);
    const event = (request as { event?: E }).event;
    let outcome: unknown;
    if (event === undefined) await driver.reset();
    else outcome = await driver.dispatch(key, event);
    const state = await driver.observe(key);
    const out = event === undefined ? [] : await output(key);
    return withOutcome && event !== undefined ? { outcome, state, out } : { state, out };
  };
  for await (const line of readline.createInterface({ input: process.stdin })) {
    if (line.trim() === "") continue;
    process.stdout.write(`${JSON.stringify(await answer(line))}\n`);
  }
  await driver[Symbol.asyncDispose]();
}
