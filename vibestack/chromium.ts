import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type BrowserInstall = "both" | "full" | "shell";

export function hostedCiWorkspace(): string | undefined {
  const { GITHUB_ACTIONS, GITHUB_REPOSITORY, GITHUB_WORKFLOW_REF, GITHUB_WORKSPACE } = process.env;
  if (GITHUB_ACTIONS === "true" && GITHUB_REPOSITORY && GITHUB_WORKSPACE
    && GITHUB_WORKFLOW_REF?.startsWith(`${GITHUB_REPOSITORY}/.github/workflows/ci.yml@`)) return GITHUB_WORKSPACE;
}

function hostedVerify() {
  const workspace = hostedCiWorkspace();
  const { GITHUB_JOB, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, PLAYWRIGHT_BROWSERS_PATH: browserPath } = process.env;
  if (process.platform !== "linux" || GITHUB_JOB !== "verify" || !workspace
    || (browserPath && !path.isAbsolute(browserPath))
    || !/^[1-9]\d*$/.test(GITHUB_RUN_ID ?? "") || !/^[1-9]\d*$/.test(GITHUB_RUN_ATTEMPT ?? "")
    || path.join(workspace, "vibestack", "chromium.ts") !== import.meta.filename) return;
  const directory = path.join(workspace, ".cache", `hosted-chromium-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`);
  return { workspace, directory, lock: path.join(directory, "lock") };
}

async function run(cwd: string, command: string, args: string[], stdout: NodeJS.WritableStream = process.stdout) {
  const { exec } = await import("./run.ts");
  const result = await exec(command, args, cwd);
  stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.stopped || result.status !== 0) throw new Error(result.stopped ?? `${command} ${args.join(" ")} exited ${result.status}`);
}

export async function installChromium(mode: BrowserInstall, cwd = process.cwd()) {
  const flags = mode === "full" ? ["--no-shell"] : mode === "shell" ? ["--only-shell"] : [];
  await run(cwd, "pnpm", ["exec", "playwright", "install", "chromium", ...flags]);
  const probe = () => run(cwd, process.execPath, ["--input-type=module", "-e", `
    import { chromium } from "playwright";
    async function check(options) {
      const browser = await chromium.launch({ timeout: 10_000, ...options });
      await browser.close();
    }
    if (process.argv[1] !== "shell") await check({ executablePath: chromium.executablePath() });
    if (process.argv[1] !== "full") await check({});
  `, mode]);
  try { await probe(); }
  catch {
    await run(cwd, "pnpm", ["exec", "playwright", "install-deps", "chromium"]);
    await probe();
  }
}

export async function prepareChromiumShell(): Promise<boolean> {
  const hosted = hostedVerify();
  if (!hosted || hosted.workspace !== process.cwd()) return false;
  await installChromium("shell", hosted.workspace);
  fs.mkdirSync(hosted.directory, { recursive: true, mode: 0o700 });
  return true;
}

async function chromiumPath(): Promise<string> {
  return (await import("playwright")).chromium.executablePath();
}

function readinessPath(directory: string, executable: string): string {
  const registry = createHash("sha256").update(executable).digest("hex");
  return path.join(directory, `full-ready-${registry}`);
}

function fullReady(ready: string, executable: string): boolean {
  return fs.existsSync(executable) && fs.lstatSync(ready, { throwIfNoEntry: false })?.isDirectory() === true;
}

export async function chromiumForExplore(): Promise<NodeJS.ProcessEnv> {
  if (process.env.CHROME) return {};
  const hosted = hostedVerify();
  if (hosted && fs.lstatSync(hosted.directory, { throwIfNoEntry: false })?.isDirectory()) {
    const executable = await chromiumPath();
    if (!fullReady(readinessPath(hosted.directory, executable), executable)) {
      await run(hosted.workspace, "flock", ["--no-fork", hosted.lock, process.execPath, import.meta.filename], process.stderr);
    }
    return { CHROME: executable };
  }
  const executable = await chromiumPath().catch(() => undefined);
  return executable && fs.existsSync(executable) ? { CHROME: executable } : {};
}

if (import.meta.main) {
  const hosted = hostedVerify();
  if (!hosted || !fs.lstatSync(hosted.directory, { throwIfNoEntry: false })?.isDirectory()) throw new Error("Chromium shell setup is required");
  const executable = await chromiumPath();
  const ready = readinessPath(hosted.directory, executable);
  if (!fullReady(ready, executable)) {
    await installChromium("full", hosted.workspace);
    if (!fs.lstatSync(ready, { throwIfNoEntry: false })?.isDirectory()) {
      fs.rmSync(ready, { force: true });
      fs.mkdirSync(ready, { mode: 0o700 });
    }
  }
}
