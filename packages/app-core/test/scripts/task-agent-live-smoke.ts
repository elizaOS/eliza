import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import fs from "node:fs";

import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime, IAgentRuntime } from "@elizaos/core";
import {
  cleanForChat,
  listAgentsAction,
  PTYService,
  sendToAgentAction,
  spawnAgentAction,
} from "@elizaos/plugin-agent-orchestrator";
import { createTestRuntime } from "../helpers/pglite-runtime";

type Framework = "claude" | "codex";
type Mode = "sequential" | "web" | "counter-app";

const KEEP_ARTIFACTS = process.env.MILADY_KEEP_LIVE_ARTIFACTS === "1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      return true;
    }

    const output = execFileSync("codex", ["login", "status"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
    return /\blogged in\b/i.test(output);
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "";

    return (
      !/\bnot logged in\b|\bno stored credentials\b|\bunauthenticated\b/i.test(detail) &&
      framework === "codex" &&
      codexHasStoredAuth()
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
  const baseDir = path.join(process.cwd(), ".tmp-live");
  fs.mkdirSync(baseDir, { recursive: true });
  return baseDir;
}

function createWorkdir(agentType: Framework, label: string): string {
  return fs.mkdtempSync(
    path.join(ensureLiveBaseDir(), `agent-orchestrator-${agentType}-${label}-`),
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
        runtime as unknown as IAgentRuntime,
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
  const service = await PTYService.start(runtime as unknown as IAgentRuntime);
  runtime.services.set("PTY_SERVICE", [service]);

  const events: Array<{ event: string; data: unknown }> = [];
  const unsubscribe = service.onSessionEvent((_sessionId, event, data) => {
    events.push({ event, data });
  });

  const firstFileName = `FIRST_${agentType.toUpperCase()}.txt`;
  const secondFileName = `SECOND_${agentType.toUpperCase()}.txt`;
  const firstFilePath = path.join(workdir, firstFileName);
  const secondFilePath = path.join(workdir, secondFileName);
  const firstSentinel = `LIVE_REUSE_${agentType.toUpperCase()}_FIRST_DONE`;
  const secondSentinel = `LIVE_REUSE_${agentType.toUpperCase()}_SECOND_DONE`;

  try {
    const [preflight] = await service.checkAvailableAgents([agentType]);
    assert.equal(preflight?.installed, true);

    const spawnResult = await spawnAgentAction.handler(
      runtime as unknown as IAgentRuntime,
      createMessage({
        agentType,
        workdir,
        task:
          `Create a file named ${firstFileName} in the current directory containing exactly "${agentType}-first". ` +
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
      runtime as unknown as IAgentRuntime,
      createMessage({
        sessionId,
        task:
          `Now create a second file named ${secondFileName} containing exactly "${agentType}-second". ` +
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
      runtime as unknown as IAgentRuntime,
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
  const service = await PTYService.start(runtime as unknown as IAgentRuntime);
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
    <h1>Milady Benchmark Ready</h1>
    <p>Task agents stay reusable.</p>
    <p>Codex and Claude Code should both handle research and serving tasks.</p>
  </body>
</html>`);

  try {
    const [preflight] = await service.checkAvailableAgents([agentType]);
    assert.equal(preflight?.installed, true);

    const spawnResult = await spawnAgentAction.handler(
      runtime as unknown as IAgentRuntime,
      createMessage({
        agentType,
        workdir,
        task:
          `Open the reference page at ${reference.url} and read it using your web or browser tools. ` +
          `Create an index.html in the current directory that includes the exact phrases "Milady Benchmark Ready" and "Task agents stay reusable." ` +
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
          html.includes("Milady Benchmark Ready") &&
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
      runtime as unknown as IAgentRuntime,
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

/**
 * Recursively copies a directory tree, applying placeholder substitutions
 * to every UTF-8-clean file. Mirrors the create-app flow's `copyTemplate`.
 */
function copyTemplateTree(
  src: string,
  dest: string,
  replacements: Record<string, string>,
): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const from = path.join(src, entry);
    const to = path.join(dest, entry);
    const stat = fs.statSync(from);
    if (stat.isDirectory()) {
      copyTemplateTree(from, to, replacements);
    } else if (stat.isFile()) {
      const raw = fs.readFileSync(from);
      const text = raw.toString("utf8");
      if (Buffer.byteLength(text, "utf8") === raw.length) {
        let rewritten = text;
        for (const [token, value] of Object.entries(replacements)) {
          rewritten = rewritten.split(token).join(value);
        }
        fs.writeFileSync(to, rewritten, "utf8");
      } else {
        fs.cpSync(from, to);
      }
    }
  }
}

const APP_CREATE_DONE_RE = /APP_CREATE_DONE\s+(\{[\s\S]*?\})/m;

/**
 * Real spawn + real LLM smoke for the APP create flow.
 *
 * Mirrors what `createAppAction({mode: "create"})` does end-to-end:
 *   1. Scaffolds `eliza/templates/min-app` into a fresh tempdir, replacing
 *      __APP_NAME__ / __APP_DISPLAY_NAME__ for a counter app.
 *   2. Spawns a real Claude Code (or Codex) child via PTYService, with the
 *      same task prompt the create flow builds.
 *   3. Polls the PTY output for the canonical APP_CREATE_DONE sentinel.
 *   4. Cross-checks the claim against disk: every claimed file exists.
 *   5. Runs the real AppVerificationService against the final workspace
 *      (typecheck + lint + test) and asserts verdict=pass.
 *
 * This is the gap I called out in the audit: until this runs green, the
 * "spawn → child writes code → emits sentinel → parent verifies" chain
 * was unverified end-to-end. Watchdog: 12 minutes for the spawn-and-code
 * cycle, plus ~10s for the verification.
 */
async function runCounterAppSmoke(agentType: Framework): Promise<void> {
  // import.meta.dirname → .../eliza/packages/app-core/test/scripts
  // 4 levels up reaches the eliza repo root where templates/min-app lives.
  const elizaRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");
  const templateSrc = path.join(elizaRoot, "templates", "min-app");
  if (!fs.existsSync(templateSrc)) {
    throw new Error(
      `min-app template not found at ${templateSrc} — re-check repo layout`,
    );
  }
  const workdir = createWorkdir(agentType, "counter-app");
  copyTemplateTree(templateSrc, workdir, {
    __APP_NAME__: "live-counter",
    __APP_DISPLAY_NAME__: "Live Counter",
  });

  const { runtime, cleanup } = await createRuntime({ SERVER_PORT: "31337" });
  const service = await PTYService.start(runtime as unknown as IAgentRuntime);
  runtime.services.set("PTY_SERVICE", [service]);

  const events: Array<{ event: string; data: unknown }> = [];
  const unsubscribe = service.onSessionEvent((_sessionId, event, data) => {
    events.push({ event, data });
  });

  // Lazy-load the verification service from plugin-app-control so we don't
  // pull it into the static import graph for the simpler smokes.
  const { AppVerificationService } = await import(
    "@elizaos/plugin-app-control"
  );
  const verifier = new AppVerificationService(
    runtime as unknown as IAgentRuntime,
  );

  try {
    const [preflight] = await service.checkAvailableAgents([agentType]);
    assert.equal(preflight?.installed, true);

    const taskPrompt = [
      'You are building a Milady app called "Live Counter".',
      "The user's intent: a tiny counter app — a single file-backed integer that goes up and down.",
      "",
      `The app source directory is ${workdir}. It has already been scaffolded from the min-app template.`,
      "Work in that source directory, not in the agent's scratch directory.",
      "Read SCAFFOLD.md in the source directory before editing.",
      "",
      "Replace the trivial hello action in src/plugin.ts with two real actions:",
      "  - INCREMENT_COUNTER — bumps a value persisted to disk",
      "  - DECREMENT_COUNTER — drops it",
      "Persist the value to a single JSON file at /tmp/live-counter.json so",
      "the count survives between handler calls. Update the existing test in",
      "tests/launch.test.ts to exercise both actions and assert persistence.",
      "",
      "Before signaling completion, run these commands from the source directory in order:",
      "  1. bun run typecheck",
      "  2. bun run lint",
      "  3. bun run test",
      "",
      "After all three pass, emit exactly one completion line in this canonical schema:",
      'APP_CREATE_DONE {"appName":"live-counter","files":["src/plugin.ts","tests/launch.test.ts"],"tests":{"passed":<exact passed count>,"failed":0},"lint":"ok","typecheck":"ok"}',
      "Use files actually changed or added. Do not emit legacy field names like 'name' or 'testsPassed'.",
    ].join("\n");

    const spawnResult = await spawnAgentAction.handler(
      runtime as unknown as IAgentRuntime,
      createMessage({
        agentType,
        workdir,
        task: taskPrompt,
      }) as never,
      undefined,
      {},
      undefined,
    );
    assert.equal(spawnResult?.success, true);
    const sessionId = String(spawnResult?.data?.sessionId);
    assert.ok(sessionId, "spawn returned no sessionId");
    await waitForTrackedSession(runtime, sessionId, agentType);

    const taskEventStart = events.length;

    let proofClaim: Record<string, unknown> | null = null;

    await waitFor(
      async () => {
        const sessionInfo = service.getSession(sessionId);
        if (!sessionInfo) {
          throw new Error("session disappeared before completing");
        }
        const recentLoginRequired = events.findLast(
          (entry) => entry.event === "login_required",
        );
        if (recentLoginRequired) {
          const details = recentLoginRequired.data as {
            instructions?: string;
          };
          throw new Error(
            details.instructions || "framework authentication is required",
          );
        }
        if (
          sessionInfo.status === "stopped" ||
          sessionInfo.status === "error"
        ) {
          const output = await service.getSessionOutput(sessionId, 400);
          throw new Error(
            `session ended early with status ${sessionInfo.status}. Output: ${output.slice(-1200)}`,
          );
        }
        const rawOutput = await service.getSessionOutput(sessionId);
        const cleaned = cleanForChat(rawOutput);
        const match = cleaned.match(APP_CREATE_DONE_RE) ??
          rawOutput.match(APP_CREATE_DONE_RE);
        if (!match) {
          return (
            sessionInfo.status === "completed" ||
            sawTaskCompletion(events, taskEventStart)
          );
        }
        try {
          proofClaim = JSON.parse(match[1]) as Record<string, unknown>;
        } catch {
          return false;
        }
        return true;
      },
      12 * 60 * 1000,
      4_000,
    );

    assert.ok(
      proofClaim,
      "child agent never emitted an APP_CREATE_DONE sentinel within the timeout",
    );

    // Cross-check the claim against disk — the orchestrator's
    // structured-proof bridge does this in production.
    assert.equal(
      (proofClaim as Record<string, unknown>).appName,
      "live-counter",
      `appName mismatch in proof: ${JSON.stringify(proofClaim)}`,
    );
    const claimedFiles = Array.isArray(
      (proofClaim as Record<string, unknown>).files,
    )
      ? ((proofClaim as Record<string, unknown>).files as unknown[]).filter(
          (f): f is string => typeof f === "string",
        )
      : [];
    assert.ok(
      claimedFiles.length > 0,
      `proof claimed no files: ${JSON.stringify(proofClaim)}`,
    );
    for (const claimed of claimedFiles) {
      const full = path.join(workdir, claimed);
      assert.ok(
        fs.existsSync(full) && fs.statSync(full).size > 0,
        `claimed file does not exist or is empty: ${full}`,
      );
    }

    // Now run the real AppVerificationService against the final
    // workspace — this is what the parent runtime would do.
    const verification = await verifier.verifyApp({
      workdir,
      appName: "live-counter",
      checks: [
        { kind: "typecheck" },
        { kind: "lint" },
        { kind: "test" },
      ],
      runId: `live-counter-${agentType}-${Date.now()}`,
      structuredProof: {
        kind: "APP_CREATE_DONE",
        ...(proofClaim as Record<string, unknown>),
      },
    });

    if (verification.verdict !== "pass") {
      const summary = verification.checks
        .map(
          (c) =>
            `  - ${c.kind}: ${c.passed ? "pass" : "FAIL"} (${c.durationMs}ms)`,
        )
        .join("\n");
      throw new Error(
        `verifyApp returned verdict=fail.\nChecks:\n${summary}\n\nRetryable prompt:\n${verification.retryablePromptForChild}`,
      );
    }
    assert.equal(verification.verdict, "pass");

    console.log(
      "[task-agent-live-smoke] counter-app verification",
      JSON.stringify({
        framework: agentType,
        sessionId,
        proofClaim,
        verdict: verification.verdict,
        checks: verification.checks.map((c) => ({
          kind: c.kind,
          passed: c.passed,
          durationMs: c.durationMs,
        })),
      }),
    );
  } finally {
    unsubscribe();
    await service.stop();
    await cleanup();
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
  console.error("[task-agent-live-smoke] FAIL");
  console.error(error);
  process.exit(1);
}
