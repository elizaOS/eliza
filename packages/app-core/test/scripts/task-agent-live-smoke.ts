/**
 * Live smoke runner for the task-agent orchestrator.
 *
 * Modes:
 *   sequential   — spawn → write file → reuse session for second task
 *   web          — spawn → fetch reference page → serve generated HTML
 *   counter-app  — run the real CLI → child creates a counter app → emits
 *                  APP_CREATE_DONE → cross-check claim against disk → run
 *                  AppVerificationService → load via APP load_from_directory
 *
 * Auth requirements (all modes):
 *
 *   The spawned PTY child needs credentials Claude Code can actually use to
 *   reach the Anthropic API. The host CLI's `claude auth status` working is
 *   NOT sufficient — that goes through the keychain-managed refresh flow
 *   which doesn't transfer to a forked PTY process.
 *
 *   What works (in priority order):
 *     1. ANTHROPIC_API_KEY env / runtime setting — bypasses OAuth entirely.
 *        spawn-agent forwards this. This is the recommended path for CI.
 *     2. A configured account-pool shim (multi-account Eliza setups). The
 *        shim picks a fresh token per spawn.
 *     3. CLAUDE_CODE_OAUTH_TOKEN env / runtime setting — forwarded by the
 *        spawn-agent fallback added in plugin-agent-orchestrator commit
 *        332a2a4. NOTE: a stale or session-bound OAuth token will be
 *        forwarded but rejected by the Anthropic API with 401. If that
 *        happens, refresh by running `claude logout && claude login` and
 *        re-export the token, OR fall back to ANTHROPIC_API_KEY.
 *
 * Run with:
 *   ORCHESTRATOR_LIVE=1 bun packages/app-core/scripts/run-node-tsx.mjs \
 *     packages/app-core/test/scripts/task-agent-live-smoke.ts \
 *     --framework <claude|codex> --mode <sequential|web|counter-app>
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import {
  cleanForChat,
  listAgentsAction,
  PTYService,
  sendToAgentAction,
  spawnAgentAction,
} from "../../../../plugins/plugin-agent-orchestrator/src/index.ts";
import {
  type AppStructuredProofClaim,
  parseStructuredProofDirective,
} from "../../../../plugins/plugin-agent-orchestrator/src/services/structured-proof-bridge.ts";
import {
  APP_REGISTRY_SERVICE_TYPE,
  AppRegistryService,
  AppVerificationService,
  createAppAction,
} from "../../../../plugins/plugin-app-control/src/index.ts";
import { createTestRuntime } from "../helpers/pglite-runtime";

type Framework = "claude" | "codex";
type Mode = "sequential" | "web" | "counter-app";

const KEEP_ARTIFACTS = process.env.ELIZA_KEEP_LIVE_ARTIFACTS === "1";
const COUNTER_AGENT_TIMEOUT_MS = 10 * 60_000;
const CODEX_UPDATE_TIMEOUT_MS = 5 * 60_000;
const CAPTURE_LIMIT = 16 * 1024 * 1024;
const CODEX_OLD_VERSION_RE = /requires a newer version of Codex/i;
const CLAUDE_AUTH_FAILURE_RE =
  /\b401\b|\binvalid authentication credentials\b|\bauthentication_error\b|\bfailed to authenticate\b/i;
const COUNTER_TOOLCHAIN_BIN = path.join(process.cwd(), "node_modules", ".bin");
const COUNTER_TYPECHECK_SCRIPT = `${COUNTER_TOOLCHAIN_BIN}/tsc --noEmit -p tsconfig.json`;
const COUNTER_LINT_SCRIPT = `${COUNTER_TOOLCHAIN_BIN}/biome check .`;
const COUNTER_TEST_SCRIPT = `${COUNTER_TOOLCHAIN_BIN}/vitest run --config ./vitest.config.ts`;

type CapturedCommandResult = {
  stdout: string;
  stderr: string;
  output: string;
};

type CommandFailure = Error & {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

class LiveAuthRequiredError extends Error {
  constructor(
    readonly framework: Framework,
    readonly mode: Mode,
    reason: string,
  ) {
    super(reason);
    this.name = "LiveAuthRequiredError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateForLog(text: string, max = 4000): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n...truncated ${text.length - max} chars`;
}

function commandFailure(
  command: string,
  args: string[],
  stdout: string,
  stderr: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): CommandFailure {
  const output = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n");
  return Object.assign(
    new Error(
      `${command} ${args.join(" ")} failed with ${
        signal ? `signal ${signal}` : `exit code ${exitCode ?? -1}`
      }\n${truncateForLog(output)}`,
    ),
    { stdout, stderr, exitCode, signal },
  );
}

function appendCapturedChunk(
  state: { stdout: string; stderr: string; overflow: boolean },
  stream: "stdout" | "stderr",
  chunk: Buffer,
): void {
  const text = chunk.toString("utf8");
  if (stream === "stdout") {
    state.stdout += text;
  } else {
    state.stderr += text;
  }
  if (state.stdout.length + state.stderr.length > CAPTURE_LIMIT) {
    state.overflow = true;
  }
}

function runCapturedCommand(
  command: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<CapturedCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const state = { stdout: "", stderr: "", overflow: false };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      appendCapturedChunk(state, "stdout", chunk);
      if (state.overflow) child.kill("SIGTERM");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      appendCapturedChunk(state, "stderr", chunk);
      if (state.overflow) child.kill("SIGTERM");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const output = [state.stdout, state.stderr]
        .filter(Boolean)
        .join("\n--- stderr ---\n");
      if (timedOut) {
        reject(
          Object.assign(
            new Error(
              `${command} ${args.join(" ")} timed out after ${opts.timeoutMs}ms\n${truncateForLog(output)}`,
            ),
            {
              stdout: state.stdout,
              stderr: state.stderr,
              exitCode: code,
              signal,
            },
          ) satisfies CommandFailure,
        );
        return;
      }
      if (state.overflow) {
        reject(
          Object.assign(
            new Error(
              `${command} ${args.join(" ")} exceeded ${CAPTURE_LIMIT} bytes of output`,
            ),
            {
              stdout: state.stdout,
              stderr: state.stderr,
              exitCode: code,
              signal,
            },
          ) satisfies CommandFailure,
        );
        return;
      }
      if (signal || code !== 0) {
        reject(
          commandFailure(
            command,
            args,
            state.stdout,
            state.stderr,
            code,
            signal,
          ),
        );
        return;
      }
      resolve({ stdout: state.stdout, stderr: state.stderr, output });
    });
  });
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error);
}

function liveCommandEnv(): NodeJS.ProcessEnv {
  const repoBin = path.join(process.cwd(), "node_modules", ".bin");
  return {
    ...process.env,
    CI: process.env.CI ?? "1",
    FORCE_COLOR: "0",
    PATH: [repoBin, process.env.PATH].filter(Boolean).join(path.delimiter),
  };
}

function isCodexCliTooOldError(error: unknown): boolean {
  return CODEX_OLD_VERSION_RE.test(errorDetail(error));
}

function isClaudeAuthFailureError(error: unknown): boolean {
  return CLAUDE_AUTH_FAILURE_RE.test(errorDetail(error));
}

function claudeNonInteractiveAuthInstructions(): string {
  return [
    "Claude Code reports a login, but non-interactive `claude -p` is rejected with 401 invalid credentials.",
    "Refresh the non-interactive Claude Code auth path by running `claude setup-token` in a terminal, or set a valid `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` for this process.",
    "After the token is refreshed, rerun the Claude live smoke.",
  ].join(" ");
}

function readCodexVersion(): string {
  return execFileSync("codex", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  }).trim();
}

function resolveCodexNpmCommand(): string {
  const codexPath = execFileSync("which", ["codex"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  }).trim();
  const colocatedNpm = path.join(path.dirname(codexPath), "npm");
  if (fs.existsSync(colocatedNpm)) return colocatedNpm;
  return "npm";
}

function resolveActiveCodexPrefix(): string {
  const codexPath = execFileSync("which", ["codex"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  }).trim();
  return path.dirname(path.dirname(codexPath));
}

async function updateCodexCli(): Promise<string> {
  const before = readCodexVersion();
  const npmCommand = resolveCodexNpmCommand();
  const codexPrefix = resolveActiveCodexPrefix();
  const update = await runCapturedCommand(
    npmCommand,
    ["install", "-g", "--prefix", codexPrefix, "@openai/codex@latest"],
    {
      timeoutMs: CODEX_UPDATE_TIMEOUT_MS,
      env: { ...process.env, CI: process.env.CI ?? "1", FORCE_COLOR: "0" },
    },
  );
  const after = readCodexVersion();
  return [
    `command=${npmCommand} install -g --prefix ${codexPrefix} @openai/codex@latest`,
    `before=${before}`,
    `after=${after}`,
    truncateForLog(update.output, 2000),
  ]
    .filter(Boolean)
    .join("\n");
}

function codexHasStoredAuth(): boolean {
  if (process.env.OPENAI_API_KEY?.trim()) {
    return true;
  }

  try {
    const authPath = path.join(os.homedir(), ".codex", "auth.json");
    const raw = fs.readFileSync(authPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return false;
    const apiKey = parsed.OPENAI_API_KEY;
    if (typeof apiKey === "string" && apiKey.trim().length > 0) return true;
    // ChatGPT-mode: tokens object with access_token + refresh_token, same
    // shape the e2e test wrapper accepts.
    const tokens = parsed.tokens;
    return (
      parsed.auth_mode === "chatgpt" &&
      isRecord(tokens) &&
      typeof tokens.access_token === "string" &&
      tokens.access_token.trim().length > 0 &&
      typeof tokens.refresh_token === "string" &&
      tokens.refresh_token.trim().length > 0
    );
  } catch {
    return false;
  }
}

function codexNonInteractiveAuthWorks(): boolean {
  if (!codexHasStoredAuth()) {
    return false;
  }

  const workdir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-live-preflight-"),
  );
  try {
    const output = execFileSync(
      "codex",
      [
        "exec",
        "--cd",
        workdir,
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        "--color",
        "never",
        "-c",
        'approval_policy="never"',
        "Reply with exactly CODEX_LIVE_PREFLIGHT_OK.",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      },
    );
    return output.includes("CODEX_LIVE_PREFLIGHT_OK");
  } catch {
    return false;
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

function claudeHasDeterministicAuth(): boolean {
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    return true;
  }
  // Claude Code reads CLAUDE_CODE_OAUTH_TOKEN at startup — that's the
  // header-passthrough auth path that survives PTY spawn.
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
    return true;
  }
  // Accept either the per-app credentials file or the OAuth-token file at
  // ~/.claude.json — same set the live e2e wrapper accepts.
  return (
    fs.existsSync(path.join(os.homedir(), ".claude", ".credentials.json")) ||
    fs.existsSync(path.join(os.homedir(), ".claude.json"))
  );
}

function isFrameworkAuthenticated(framework: Framework): boolean {
  if (framework === "claude" && !claudeHasDeterministicAuth()) {
    return false;
  }
  if (
    framework === "claude" &&
    (process.env.ANTHROPIC_API_KEY?.trim() ||
      process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim())
  ) {
    return true;
  }

  try {
    if (framework === "claude") {
      const output = execFileSync("claude", ["auth", "status"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
      });
      return /"loggedIn"\s*:\s*true|\blogged in\b/i.test(output);
    }

    if (codexHasStoredAuth()) {
      return codexNonInteractiveAuthWorks();
    }

    const output = execFileSync("codex", ["login", "status"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
    return /\blogged in\b/i.test(output) && codexNonInteractiveAuthWorks();
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "";

    return (
      !/\bnot logged in\b|\bno stored credentials\b|\bunauthenticated\b/i.test(
        detail,
      ) &&
      framework === "codex" &&
      codexNonInteractiveAuthWorks()
    );
  }
}

async function createRuntime(settings: Record<string, unknown> = {}): Promise<{
  runtime: AgentRuntime;
  cleanup: () => Promise<void>;
}> {
  const { runtime, cleanup } = await createTestRuntime({
    characterName: "TaskAgentLiveSmoke",
  });
  const originalGetSetting = runtime.getSetting.bind(runtime);
  runtime.getSetting = ((key: string) =>
    settings[key] ??
    originalGetSetting(key) ??
    process.env[key]) as typeof runtime.getSetting;
  return { runtime, cleanup };
}

function createMessage(content: Record<string, unknown> = {}) {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    userId: "live-user",
    entityId: "live-user",
    roomId: "live-room",
    createdAt: Date.now(),
    content,
  };
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTextIfAvailable(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    return await response.text();
  } catch {
    // The local HTTP server is expected to refuse connections until the agent starts it.
    return null;
  }
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await wait(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function ensureLiveBaseDir(): string {
  const baseDir = path.join(process.cwd(), "tmp-live");
  fs.mkdirSync(baseDir, { recursive: true });
  return baseDir;
}

function createWorkdir(agentType: Framework, label: string): string {
  return fs.mkdtempSync(
    path.join(ensureLiveBaseDir(), `agent-orchestrator-${agentType}-${label}-`),
  );
}

function createCounterWorkdir(agentType: Framework): string {
  const baseDir = path.join(os.tmpdir(), "eliza-live");
  fs.mkdirSync(baseDir, { recursive: true });
  return fs.mkdtempSync(
    path.join(baseDir, `agent-orchestrator-${agentType}-counter-app-`),
  );
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to allocate an ephemeral port");
  }
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startReferenceServer(html: string): Promise<{
  server: Server;
  url: string;
}> {
  const port = await getFreePort();
  const server = createServer((_, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    server,
    url: `http://127.0.0.1:${port}/reference.html`,
  };
}

function sawTaskCompletion(
  events: Array<{ event: string; data: unknown }>,
  startIndex: number,
): boolean {
  return events
    .slice(startIndex)
    .some(
      (entry) => entry.event === "task_complete" || entry.event === "completed",
    );
}

async function waitForTrackedSession(
  runtime: AgentRuntime,
  sessionId: string,
  expectedAgentType: Framework,
): Promise<void> {
  let listResult:
    | Awaited<ReturnType<typeof listAgentsAction.handler>>
    | undefined;
  await waitFor(
    async () => {
      listResult = await listAgentsAction.handler(
        runtime,
        createMessage({}) as never,
      );
      if (!listResult?.success) {
        return false;
      }
      const sessions = Array.isArray(listResult.data?.sessions)
        ? listResult.data.sessions
        : [];
      const tasks = Array.isArray(listResult.data?.tasks)
        ? listResult.data.tasks
        : [];
      return (
        sessions.some((entry) => entry.id === sessionId) &&
        tasks.some(
          (entry) =>
            entry.sessionId === sessionId &&
            entry.agentType === expectedAgentType,
        )
      );
    },
    45_000,
    1_000,
  );

  assert.ok(listResult?.text.includes(sessionId));
  assert.ok(listResult?.text.includes(expectedAgentType));
}

async function runSequentialSmoke(agentType: Framework): Promise<void> {
  const workdir = createWorkdir(agentType, "reuse");
  const { runtime, cleanup } = await createRuntime({ SERVER_PORT: "31337" });
  const service = await PTYService.start(runtime);
  runtime.services.set("PTY_SERVICE", [service]);

  const events: Array<{ event: string; data: unknown }> = [];
  const unsubscribe = service.onSessionEvent((_sessionId, event, data) => {
    events.push({ event, data });
  });

  const firstFileName = `FIRST_${agentType.toUpperCase()}.txt`;
  const secondFileName = `SECOND_${agentType.toUpperCase()}.txt`;
  const firstDoneFileName = `FIRST_${agentType.toUpperCase()}.done`;
  const secondDoneFileName = `SECOND_${agentType.toUpperCase()}.done`;
  const firstFilePath = path.join(workdir, firstFileName);
  const secondFilePath = path.join(workdir, secondFileName);
  const firstDoneFilePath = path.join(workdir, firstDoneFileName);
  const secondDoneFilePath = path.join(workdir, secondDoneFileName);
  const firstSentinel = `LIVE_REUSE_${agentType.toUpperCase()}_FIRST_DONE`;
  const secondSentinel = `LIVE_REUSE_${agentType.toUpperCase()}_SECOND_DONE`;

  try {
    const [preflight] = await service.checkAvailableAgents([agentType]);
    assert.equal(preflight?.installed, true);

    const spawnResult = await spawnAgentAction.handler(
      runtime,
      createMessage({
        agentType,
        workdir,
        keepAliveAfterComplete: true,
        task:
          `Use your shell tool to write exactly "${agentType}-first" to ${firstFilePath} and exactly "${firstSentinel}" to ${firstDoneFilePath}. ` +
          `Then print exactly "${firstSentinel}". Do not ask follow-up questions.`,
      }) as never,
      undefined,
      {},
      undefined,
    );
    assert.equal(spawnResult?.success, true);
    assert.ok(spawnResult?.data?.sessionId);

    const sessionId = String(spawnResult?.data?.sessionId);
    await waitForTrackedSession(runtime, sessionId, agentType);
    const firstTaskEventStart = events.length;

    await waitFor(
      async () => {
        const sessionInfo = service.getSession(sessionId);
        if (!sessionInfo) {
          throw new Error(
            "session disappeared before completing the first task",
          );
        }
        const recentLoginRequired = events.findLast(
          (entry) => entry.event === "login_required",
        );
        if (recentLoginRequired) {
          const details = recentLoginRequired.data as { instructions?: string };
          throw new Error(
            details.instructions || "framework authentication is required",
          );
        }
        if (
          sessionInfo.status === "stopped" ||
          sessionInfo.status === "error"
        ) {
          const output = await service.getSessionOutput(sessionId, 200);
          throw new Error(
            `session ended early with status ${sessionInfo.status}. Output: ${output.slice(-600)}`,
          );
        }
        if (!fs.existsSync(firstFilePath)) return false;
        const fileText = fs.readFileSync(firstFilePath, "utf8").trim();
        if (fileText !== `${agentType}-first`) return false;
        if (!fs.existsSync(firstDoneFilePath)) return false;
        const doneText = fs.readFileSync(firstDoneFilePath, "utf8").trim();
        if (doneText !== firstSentinel) return false;
        const output = cleanForChat(await service.getSessionOutput(sessionId));
        return (
          output.includes(firstSentinel) ||
          sawTaskCompletion(events, firstTaskEventStart)
        );
      },
      6 * 60 * 1000,
      3000,
    );

    const secondTaskEventStart = events.length;
    const sendResult = await sendToAgentAction.handler(
      runtime,
      createMessage({
        sessionId,
        task:
          `Use your shell tool to write exactly "${agentType}-second" to ${secondFilePath} and exactly "${secondSentinel}" to ${secondDoneFilePath}. ` +
          `Then print exactly "${secondSentinel}". Stay available for more work afterward and do not ask follow-up questions.`,
      }) as never,
      undefined,
      {},
      undefined,
    );
    assert.equal(sendResult?.success, true);

    await waitFor(
      async () => {
        if (!fs.existsSync(secondFilePath)) return false;
        const fileText = fs.readFileSync(secondFilePath, "utf8").trim();
        if (fileText !== `${agentType}-second`) return false;
        if (!fs.existsSync(secondDoneFilePath)) return false;
        const doneText = fs.readFileSync(secondDoneFilePath, "utf8").trim();
        if (doneText !== secondSentinel) return false;
        const output = cleanForChat(await service.getSessionOutput(sessionId));
        return (
          output.includes(secondSentinel) ||
          sawTaskCompletion(events, secondTaskEventStart)
        );
      },
      6 * 60 * 1000,
      3000,
    );

    const finalList = await listAgentsAction.handler(
      runtime,
      createMessage({}) as never,
    );
    assert.equal(finalList?.success, true);
    assert.ok(finalList?.text.includes(sessionId));
  } finally {
    unsubscribe();
    await service.stop();
    await cleanup();
    if (!KEEP_ARTIFACTS) {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  }
}

async function runWebSmoke(agentType: Framework): Promise<void> {
  const workdir = createWorkdir(agentType, "web");
  const { runtime, cleanup } = await createRuntime({ SERVER_PORT: "31337" });
  const service = await PTYService.start(runtime);
  runtime.services.set("PTY_SERVICE", [service]);

  const events: Array<{ event: string; data: unknown }> = [];
  const unsubscribe = service.onSessionEvent((_sessionId, event, data) => {
    events.push({ event, data });
  });

  const agentPort = await getFreePort();
  const serveSentinel = `LIVE_WEB_${agentType.toUpperCase()}_READY`;
  const reference = await startReferenceServer(`<!doctype html>
<html>
  <body>
    <h1>Eliza Benchmark Ready</h1>
    <p>Task agents stay reusable.</p>
    <p>Codex and Claude Code should both handle research and serving tasks.</p>
  </body>
</html>`);

  try {
    const [preflight] = await service.checkAvailableAgents([agentType]);
    assert.equal(preflight?.installed, true);

    const spawnResult = await spawnAgentAction.handler(
      runtime,
      createMessage({
        agentType,
        workdir,
        task:
          `Open the reference page at ${reference.url} and read it using your web or browser tools. ` +
          `Create an index.html in the current directory that includes the exact phrases "Eliza Benchmark Ready" and "Task agents stay reusable." ` +
          `Then start a local HTTP server in the background from the current directory with ` +
          `"python3 -m http.server ${agentPort} >/tmp/${serveSentinel}.log 2>&1 & echo $! > server.pid", ` +
          `print exactly "${serveSentinel}", and keep the server available until I stop you. ` +
          `Do not ask follow-up questions.`,
      }) as never,
      undefined,
      {},
      undefined,
    );
    assert.equal(spawnResult?.success, true);
    assert.ok(spawnResult?.data?.sessionId);

    const sessionId = String(spawnResult?.data?.sessionId);
    await waitForTrackedSession(runtime, sessionId, agentType);
    const webTaskEventStart = events.length;

    await waitFor(
      async () => {
        const sessionInfo = service.getSession(sessionId);
        if (!sessionInfo) {
          throw new Error("session disappeared before completing the web task");
        }
        const recentLoginRequired = events.findLast(
          (entry) => entry.event === "login_required",
        );
        if (recentLoginRequired) {
          const details = recentLoginRequired.data as { instructions?: string };
          throw new Error(
            details.instructions || "framework authentication is required",
          );
        }
        if (
          sessionInfo.status === "stopped" ||
          sessionInfo.status === "error"
        ) {
          const output = await service.getSessionOutput(sessionId, 200);
          throw new Error(
            `web task ended early with status ${sessionInfo.status}. Output: ${output.slice(-600)}`,
          );
        }
        const html = await fetchTextIfAvailable(
          `http://127.0.0.1:${agentPort}/index.html`,
        );
        if (!html) return false;
        return (
          html.includes("Eliza Benchmark Ready") &&
          html.includes("Task agents stay reusable.") &&
          (cleanForChat(await service.getSessionOutput(sessionId)).includes(
            serveSentinel,
          ) ||
            sawTaskCompletion(events, webTaskEventStart))
        );
      },
      6 * 60 * 1000,
      3000,
    );

    const finalList = await listAgentsAction.handler(
      runtime,
      createMessage({}) as never,
    );
    assert.equal(finalList?.success, true);
    assert.ok(finalList?.text.includes(sessionId));
  } finally {
    unsubscribe();
    await new Promise<void>((resolve) =>
      reference.server.close(() => resolve()),
    );
    await service.stop();
    await cleanup();
    if (!KEEP_ARTIFACTS) {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  }
}

function readJsonObject(file: string): Record<string, unknown> {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Expected JSON object at ${file}`);
  }
  return parsed;
}

function createCounterAppPrompt(input: {
  agentType: Framework;
  appDir: string;
  appName: string;
  appSlug: string;
  displayName: string;
}): string {
  const expectedFiles = [
    "package.json",
    "tsconfig.json",
    "biome.json",
    "vitest.config.ts",
    "index.html",
    "src/counter.ts",
    "src/main.ts",
    "tests/counter.test.ts",
  ];
  return [
    "Create a complete, minimal Eliza Eliza app for a browser counter.",
    "",
    `Agent framework under test: ${input.agentType}.`,
    `Create the app package at exactly: ${input.appDir}`,
    `Package name: ${input.appName}`,
    `App slug: ${input.appSlug}`,
    `Display name: ${input.displayName}`,
    "",
    "The package must be self-contained and use vanilla TypeScript. Do not install dependencies.",
    "Create these files and include all of them in the final files claim:",
    ...expectedFiles.map((file) => `- ${file}`),
    "",
    "package.json requirements:",
    '- "type": "module"',
    `- scripts.typecheck = "${COUNTER_TYPECHECK_SCRIPT}"`,
    `- scripts.lint = "${COUNTER_LINT_SCRIPT}"`,
    `- scripts.test = "${COUNTER_TEST_SCRIPT}"`,
    `- elizaos.app.displayName = "${input.displayName}"`,
    `- elizaos.app.slug = "${input.appSlug}"`,
    '- elizaos.app.category = "utility"',
    "",
    "Counter behavior requirements:",
    "- src/counter.ts exports a CounterState type and a nextCount(state, delta) function.",
    "- index.html contains the visible counter value and increment/decrement buttons.",
    '- src/main.ts imports nextCount and wires button click handlers with addEventListener("click", ...).',
    "- tests/counter.test.ts verifies increment and decrement behavior by importing nextCount.",
    "",
    "Before signaling completion, run these commands from the app package directory in order:",
    "1. bun run typecheck",
    "2. bun run lint",
    "3. bun run test",
    "The repo node_modules/.bin directory is already on PATH; do not search the filesystem for tsc, biome, or vitest.",
    "",
    "After all three commands exit zero, emit exactly one final stdout line.",
    "That final line must start with APP_CREATE_DONE, followed by one space, then a JSON object with fields: appName, files, tests, lint, typecheck.",
    `The JSON appName field must be "${input.appName}".`,
    "The JSON tests.failed field must be 0, and tests.passed must match the Vitest Tests summary.",
    'The JSON lint and typecheck fields must both be "ok".',
    "Do not emit APP_CREATE_DONE until verification has passed.",
  ].join("\n");
}

async function runCounterAgentCli(
  agentType: Framework,
  task: string,
  workdir: string,
): Promise<string> {
  const env = liveCommandEnv();
  if (agentType === "claude") {
    const model = process.env.ELIZA_LIVE_CLAUDE_MODEL?.trim();
    const args = [
      "-p",
      "--dangerously-skip-permissions",
      "--output-format",
      "text",
      ...(model ? ["--model", model] : []),
      task,
    ];
    const result = await runCapturedCommand("claude", args, {
      cwd: workdir,
      env,
      timeoutMs: COUNTER_AGENT_TIMEOUT_MS,
    });
    return result.output;
  }

  const model = process.env.ELIZA_LIVE_CODEX_MODEL?.trim();
  const args = [
    "exec",
    "--cd",
    workdir,
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    "--color",
    "never",
    "-c",
    'approval_policy="never"',
    ...(model ? ["--model", model] : []),
    task,
  ];
  const result = await runCapturedCommand("codex", args, {
    cwd: workdir,
    env,
    timeoutMs: COUNTER_AGENT_TIMEOUT_MS,
  });
  return result.output;
}

async function runCounterAgentCliWithCodexUpdate(
  agentType: Framework,
  task: string,
  workdir: string,
): Promise<string> {
  try {
    return await runCounterAgentCli(agentType, task, workdir);
  } catch (error) {
    if (agentType === "claude" && isClaudeAuthFailureError(error)) {
      throw new LiveAuthRequiredError(
        agentType,
        "counter-app",
        claudeNonInteractiveAuthInstructions(),
      );
    }
    if (agentType !== "codex" || !isCodexCliTooOldError(error)) {
      throw error;
    }
    const updateDetail = await updateCodexCli().catch((updateError) => {
      throw new Error(
        [
          "Codex CLI reported that the configured model requires a newer CLI, and automatic update failed.",
          "Original Codex failure:",
          errorDetail(error),
          "Update failure:",
          errorDetail(updateError),
        ].join("\n"),
      );
    });
    console.log(
      "[task-agent-live-smoke] CODEX_UPDATE",
      JSON.stringify({
        framework: agentType,
        mode: "counter-app",
        detail: truncateForLog(updateDetail, 1200),
      }),
    );
    try {
      return await runCounterAgentCli(agentType, task, workdir);
    } catch (retryError) {
      if (isCodexCliTooOldError(retryError)) {
        throw new Error(
          [
            "Codex CLI still reports an old-version error after automatic update.",
            "Update detail:",
            updateDetail,
            "Retry failure:",
            errorDetail(retryError),
          ].join("\n"),
        );
      }
      throw retryError;
    }
  }
}

function extractAppProof(output: string): AppStructuredProofClaim {
  const invalidReasons: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const parsed = parseStructuredProofDirective(line);
    if (!parsed) continue;
    if (!parsed.ok) {
      invalidReasons.push(parsed.reason);
      continue;
    }
    if (parsed.parsed.kind !== "APP_CREATE_DONE") {
      invalidReasons.push(`unexpected proof kind ${parsed.parsed.kind}`);
      continue;
    }
    return parsed.parsed.claim;
  }

  const invalid = invalidReasons.length
    ? `\nMalformed APP_CREATE_DONE lines:\n${invalidReasons.map((r) => `- ${r}`).join("\n")}`
    : "";
  throw new Error(
    `No valid APP_CREATE_DONE proof found in agent output.${invalid}\nOutput tail:\n${truncateForLog(output.slice(-6000))}`,
  );
}

function assertCounterAppDisk(input: {
  appDir: string;
  appName: string;
  appSlug: string;
  displayName: string;
  proof: AppStructuredProofClaim;
}): void {
  assert.equal(input.proof.appName, input.appName);
  const expectedFiles = [
    "package.json",
    "tsconfig.json",
    "biome.json",
    "vitest.config.ts",
    "index.html",
    "src/counter.ts",
    "src/main.ts",
    "tests/counter.test.ts",
  ];
  for (const file of expectedFiles) {
    assert.ok(
      input.proof.files.includes(file),
      `APP_CREATE_DONE files must include ${file}`,
    );
    const full = path.join(input.appDir, file);
    assert.ok(
      fs.existsSync(full) && fs.statSync(full).size > 0,
      `expected non-empty file at ${full}`,
    );
  }
  for (const claimed of input.proof.files) {
    assert.ok(
      !path.isAbsolute(claimed),
      `claimed file must be relative: ${claimed}`,
    );
    const full = path.resolve(input.appDir, claimed);
    assert.ok(
      path.relative(input.appDir, full).startsWith("..") === false,
      `claimed file escapes app dir: ${claimed}`,
    );
    assert.ok(
      fs.existsSync(full) && fs.statSync(full).size > 0,
      `claimed file missing or empty: ${full}`,
    );
  }

  const pkg = readJsonObject(path.join(input.appDir, "package.json"));
  assert.equal(pkg.name, input.appName);
  const scripts = isRecord(pkg.scripts) ? pkg.scripts : null;
  assert.ok(scripts, "package.json must include scripts");
  assert.equal(scripts.typecheck, COUNTER_TYPECHECK_SCRIPT);
  assert.equal(scripts.lint, COUNTER_LINT_SCRIPT);
  assert.equal(scripts.test, COUNTER_TEST_SCRIPT);
  const elizaos = isRecord(pkg.elizaos) ? pkg.elizaos : null;
  const app = elizaos && isRecord(elizaos.app) ? elizaos.app : null;
  assert.ok(app, "package.json must include elizaos.app metadata");
  assert.equal(app.displayName, input.displayName);
  assert.equal(app.slug, input.appSlug);

  const allText = expectedFiles
    .map((file) => fs.readFileSync(path.join(input.appDir, file), "utf8"))
    .join("\n");
  for (const placeholder of [
    "__APP_NAME__",
    "__APP_DISPLAY_NAME__",
    "__PLUGIN_NAME__",
    "__PLUGIN_DISPLAY_NAME__",
  ]) {
    assert.ok(
      !allText.includes(placeholder),
      `placeholder remains: ${placeholder}`,
    );
  }

  const index = fs.readFileSync(path.join(input.appDir, "index.html"), "utf8");
  const main = fs.readFileSync(
    path.join(input.appDir, "src", "main.ts"),
    "utf8",
  );
  const counter = fs.readFileSync(
    path.join(input.appDir, "src", "counter.ts"),
    "utf8",
  );
  const test = fs.readFileSync(
    path.join(input.appDir, "tests", "counter.test.ts"),
    "utf8",
  );
  assert.match(index, /<button\b/i);
  assert.match(main, /addEventListener\(["']click["']/);
  assert.match(main, /nextCount/);
  assert.match(counter, /export\s+function\s+nextCount/);
  assert.match(test, /nextCount/);
}

/**
 * Real CLI + real LLM smoke for the APP create/load flow.
 */
async function runCounterAppSmoke(agentType: Framework): Promise<void> {
  const workdir = createCounterWorkdir(agentType);
  const appSlug = `counter-live-${agentType}`;
  const appName = `@eliza/${appSlug}`;
  const displayName =
    agentType === "codex" ? "Live Counter Codex" : "Live Counter Claude";
  const appDir = path.join(workdir, appSlug);
  const stateDir = path.join(workdir, ".state");
  const previousStateDir = process.env.ELIZA_STATE_DIR;
  const previousElizaStateDir = process.env.ELIZA_STATE_DIR;
  process.env.ELIZA_STATE_DIR = stateDir;
  const { runtime, cleanup } = await createRuntime({ SERVER_PORT: "31337" });
  const appRegistry = await AppRegistryService.start(
    runtime,
  );
  const appVerification = new AppVerificationService(
    runtime,
  );
  runtime.services.set(APP_REGISTRY_SERVICE_TYPE, [appRegistry]);
  runtime.services.set(AppVerificationService.serviceType, [appVerification]);

  try {
    const taskPrompt = createCounterAppPrompt({
      agentType,
      appDir,
      appName,
      appSlug,
      displayName,
    });

    const rawOutput = await runCounterAgentCliWithCodexUpdate(
      agentType,
      taskPrompt,
      workdir,
    );
    const proof = extractAppProof(rawOutput);
    assertCounterAppDisk({ appDir, appName, appSlug, displayName, proof });

    const verification = await appVerification.verifyApp({
      workdir: appDir,
      appName,
      checks: [{ kind: "typecheck" }, { kind: "lint" }, { kind: "test" }],
      packageManager: "bun",
      requireStructuredProof: true,
      structuredProof: proof,
      runId: `live-counter-${agentType}-${Date.now()}`,
    });

    if (verification.verdict !== "pass") {
      const summary = verification.checks
        .map(
          (check) =>
            `  - ${check.kind}: ${check.passed ? "pass" : "FAIL"} (${check.durationMs}ms)`,
        )
        .join("\n");
      throw new Error(
        `verifyApp returned verdict=fail.\nChecks:\n${summary}\n\nRetryable prompt:\n${verification.retryablePromptForChild}`,
      );
    }

    const appAction = createAppAction({
      hasOwnerAccess: async () => true,
    });
    const loadResult = await appAction.handler(
      runtime,
      createMessage({
        text: `load apps from ${workdir} directory`,
      }) as never,
      undefined,
      { mode: "load_from_directory", directory: workdir },
      undefined,
    );
    assert.equal(loadResult?.success, true);
    const registered = await appRegistry.list();
    const registeredApp = registered.find((entry) => entry.slug === appSlug);
    assert.ok(
      registeredApp,
      `APP/load_from_directory did not register ${appSlug}`,
    );
    assert.equal(registeredApp.canonicalName, appName);
    assert.equal(registeredApp.displayName, displayName);
    assert.equal(path.resolve(registeredApp.directory), path.resolve(appDir));

    console.log(
      "[task-agent-live-smoke] counter-app verification",
      JSON.stringify({
        agentType,
        appName,
        appSlug,
        registeredDirectory: registeredApp.directory,
        proof,
        verdict: verification.verdict,
        checks: verification.checks.map((c) => ({
          kind: c.kind,
          passed: c.passed,
          durationMs: c.durationMs,
        })),
      }),
    );
  } finally {
    await appVerification.stop();
    await appRegistry.stop();
    await cleanup();
    if (previousStateDir !== undefined) {
      process.env.ELIZA_STATE_DIR = previousStateDir;
    } else {
      delete process.env.ELIZA_STATE_DIR;
    }
    if (previousElizaStateDir !== undefined) {
      process.env.ELIZA_STATE_DIR = previousElizaStateDir;
    } else {
      delete process.env.ELIZA_STATE_DIR;
    }
    if (!KEEP_ARTIFACTS) {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  const frameworkIndex = process.argv.indexOf("--framework");
  const modeIndex = process.argv.indexOf("--mode");
  const framework =
    frameworkIndex !== -1
      ? (process.argv[frameworkIndex + 1] as Framework)
      : null;
  const mode = modeIndex !== -1 ? (process.argv[modeIndex + 1] as Mode) : null;

  if (
    (framework !== "claude" && framework !== "codex") ||
    (mode !== "sequential" && mode !== "web" && mode !== "counter-app")
  ) {
    throw new Error(
      "Usage: task-agent-live-smoke.ts --framework <claude|codex> --mode <sequential|web|counter-app>",
    );
  }

  if (!isFrameworkAuthenticated(framework)) {
    console.log(
      "[task-agent-live-smoke] SKIP",
      JSON.stringify({
        framework,
        mode,
        reason: `${framework} is not authenticated on this machine`,
      }),
    );
    return;
  }

  if (mode === "sequential") {
    await runSequentialSmoke(framework);
  } else if (mode === "web") {
    await runWebSmoke(framework);
  } else {
    await runCounterAppSmoke(framework);
  }

  console.log(
    "[task-agent-live-smoke] PASS",
    JSON.stringify({ framework, mode }),
  );
}

try {
  await main();
  process.exit(0);
} catch (error) {
  if (error instanceof LiveAuthRequiredError) {
    console.log(
      "[task-agent-live-smoke] AUTH_REQUIRED",
      JSON.stringify({
        framework: error.framework,
        mode: error.mode,
        reason: error.message,
      }),
    );
    process.exit(0);
  }
  console.error("[task-agent-live-smoke] FAIL");
  console.error(error);
  process.exit(1);
}
