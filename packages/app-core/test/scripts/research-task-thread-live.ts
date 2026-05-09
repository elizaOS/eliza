import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { SwarmCoordinator } from "@elizaos/plugin-agent-orchestrator";
import { createTestRuntime } from "../helpers/pglite-runtime";

type CodexEvent =
  | {
      type: "item.completed";
      item?: {
        type?: string;
        action?: {
          type?: string;
          url?: string;
          query?: string;
          queries?: string[];
        };
      };
    }
  | {
      type: "item.started";
      item?: {
        type?: string;
        action?: {
          type?: string;
          url?: string;
          query?: string;
          queries?: string[];
        };
      };
    }
  | {
      type: "turn.completed";
    }
  | Record<string, unknown>;

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const RESEARCH_PROMPT =
  "Use web search only. Find the official Playwright browser support page and the official Puppeteer supported browsers page. " +
  "Return a concise Markdown report with sections Summary, Tradeoffs, and Sources. Include at least two source URLs and no code blocks.";
const KEEP_ARTIFACTS = process.env.ELIZA_KEEP_LIVE_ARTIFACTS === "1";

let runtime: AgentRuntime | undefined;
let cleanupRuntime: (() => Promise<void>) | undefined;
let reportDir: string | undefined;

function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `${command} timed out after ${Math.round(options.timeoutMs / 1000)} seconds`,
        ),
      );
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
      });
    });
  });
}

function parseCodexEvents(stdout: string): CodexEvent[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"))
    .map((line) => {
      try {
        return JSON.parse(line) as CodexEvent;
      } catch {
        return null;
      }
    })
    .filter((event): event is CodexEvent => event !== null);
}

async function cleanup(): Promise<void> {
  try {
    await cleanupRuntime?.();
  } catch {}

  if (reportDir) {
    if (KEEP_ARTIFACTS) {
      console.log(
        "[research-task-thread-live] preserving artifacts",
        JSON.stringify({ reportDir }),
      );
    } else {
      fs.rmSync(reportDir, { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  ({ runtime, cleanup: cleanupRuntime } = await createTestRuntime());

  const coordinator = new SwarmCoordinator(runtime);
  const thread = await coordinator.createTaskThread({
    title: "Live Codex research report",
    originalRequest: RESEARCH_PROMPT,
    kind: "research",
    metadata: {
      source: "research-task-thread-live",
      provider: "codex-subscription",
    },
  });

  reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-research-thread-"));
  const transcriptPath = path.join(
    reportDir,
    "codex-research-transcript.jsonl",
  );
  const finalMessagePath = path.join(reportDir, "codex-final-message.md");
  const reportPath = path.join(reportDir, "deep-research-report.md");
  const sessionId = `research-codex-${Date.now()}`;
  const startedAt = Date.now();

  await coordinator.taskRegistry.registerSession({
    threadId: thread.id,
    sessionId,
    framework: "codex",
    providerSource: "subscription",
    label: "codex-live-research",
    originalTask: thread.originalRequest,
    workdir: reportDir,
    status: "active",
    taskDelivered: true,
    registeredAt: startedAt,
    lastActivityAt: startedAt,
    metadata: {
      kind: "research",
      mode: "codex-search-exec",
    },
  });

  await coordinator.taskRegistry.appendEvent({
    threadId: thread.id,
    sessionId,
    eventType: "research_started",
    summary: "Started live Codex research run",
    data: {
      provider: "codex",
      searchEnabled: true,
    },
  });

  const codexEnv = { ...process.env };
  delete codexEnv.OPENAI_API_KEY;
  delete codexEnv.OPENAI_BASE_URL;

  const commandResult = await runCommand(
    "codex",
    [
      "-a",
      "never",
      "--search",
      "-c",
      'model_reasoning_effort="low"',
      "exec",
      "--skip-git-repo-check",
      "--cd",
      reportDir,
      "--sandbox",
      "workspace-write",
      "--json",
      "-o",
      finalMessagePath,
      RESEARCH_PROMPT,
    ],
    {
      cwd: reportDir,
      env: codexEnv,
      timeoutMs: 12 * 60_000,
    },
  );

  fs.writeFileSync(transcriptPath, commandResult.stdout, "utf8");

  assert.equal(
    commandResult.exitCode,
    0,
    `Expected codex research run to exit 0, got ${commandResult.exitCode}\n${commandResult.stderr}`,
  );
  assert.ok(
    fs.existsSync(finalMessagePath),
    "Expected Codex research run to write a final message file",
  );

  const finalMessage = fs.readFileSync(finalMessagePath, "utf8").trim();
  assert.ok(
    finalMessage.length > 0,
    "Expected Codex research run to return a non-empty report",
  );

  const events = parseCodexEvents(commandResult.stdout);
  const searchEvents = events.filter(
    (event) =>
      (event.type === "item.completed" || event.type === "item.started") &&
      event.item?.type === "web_search" &&
      (event.item.action?.type === "search" ||
        (typeof event.item.action?.query === "string" &&
          event.item.action.query.length > 0) ||
        (Array.isArray(event.item.action?.queries) &&
          event.item.action.queries.length > 0) ||
        (typeof event.item.action?.url === "string" &&
          event.item.action.url.length > 0)),
  );
  assert.ok(
    searchEvents.length > 0,
    "Expected Codex research run to record at least one real web_search event",
  );
  assert.match(
    finalMessage,
    /https?:\/\//,
    "Expected Codex research report to include source URLs",
  );

  const uniqueSearchQueries = [
    ...new Set(
      searchEvents.flatMap((event) => {
        const action = event.item?.action;
        if (!action) {
          return [];
        }
        const queries = Array.isArray(action.queries) ? action.queries : [];
        return [
          ...(typeof action.query === "string" && action.query.length > 0
            ? [action.query]
            : []),
          ...queries,
        ];
      }),
    ),
  ];
  const reportBody = [
    "# Live Codex Research Report",
    "",
    finalMessage,
    "",
    "## Observed Search Queries",
    ...uniqueSearchQueries.map((query) => `- ${query}`),
  ].join("\n");
  fs.writeFileSync(reportPath, reportBody, "utf8");

  await coordinator.taskRegistry.recordTranscript({
    threadId: thread.id,
    sessionId,
    direction: "stdout",
    content: finalMessage,
  });
  await coordinator.taskRegistry.recordArtifact({
    threadId: thread.id,
    sessionId,
    artifactType: "research_report",
    title: "Live Codex research report",
    path: reportPath,
    mimeType: "text/markdown",
    metadata: {
      provider: "codex",
      searchEventCount: searchEvents.length,
      searchQueries: uniqueSearchQueries,
    },
  });
  await coordinator.taskRegistry.recordArtifact({
    threadId: thread.id,
    sessionId,
    artifactType: "transcript",
    title: "Codex research transcript",
    path: transcriptPath,
    mimeType: "application/jsonl",
    metadata: {
      provider: "codex",
      stderrLength: commandResult.stderr.length,
    },
  });
  await coordinator.taskRegistry.updateSession(sessionId, {
    status: "completed",
    completionSummary: finalMessage.slice(0, 240),
    lastActivityAt: Date.now(),
  });
  await coordinator.taskRegistry.updateThreadSummary(
    thread.id,
    finalMessage.slice(0, 400),
  );
  await coordinator.taskRegistry.appendEvent({
    threadId: thread.id,
    sessionId,
    eventType: "research_completed",
    summary: "Completed live Codex research run",
    data: {
      provider: "codex",
      searchEventCount: searchEvents.length,
      queryCount: uniqueSearchQueries.length,
    },
  });

  const detail = await coordinator.getTaskThread(thread.id);
  assert.ok(detail, "Expected task thread detail after research run");
  assert.equal(detail.kind, "research");
  assert.ok(
    detail.sessions.some(
      (session) =>
        session.sessionId === sessionId && session.status === "completed",
    ),
    "Expected the research run to persist as a completed session",
  );
  assert.ok(
    detail.artifacts.some(
      (artifact) =>
        artifact.sessionId === sessionId &&
        artifact.artifactType === "research_report" &&
        artifact.path === reportPath,
    ),
    "Expected the research report artifact to be attached to the task thread",
  );
  assert.ok(
    detail.artifacts.some(
      (artifact) =>
        artifact.sessionId === sessionId &&
        artifact.artifactType === "transcript" &&
        artifact.path === transcriptPath,
    ),
    "Expected the research transcript artifact to be attached to the task thread",
  );
  assert.ok(
    detail.events.some((event) => event.eventType === "research_completed"),
    "Expected the task thread to record research completion",
  );

  console.log(
    "[research-task-thread-live] PASS",
    JSON.stringify({
      threadId: thread.id,
      sessionId,
      reportDir,
      reportPath,
      transcriptPath,
      searchEventCount: searchEvents.length,
      queryCount: uniqueSearchQueries.length,
    }),
  );
}

try {
  await main();
  await cleanup();
  process.exit(0);
} catch (error) {
  console.error("[research-task-thread-live] FAIL");
  console.error(error);
  await cleanup();
  process.exit(1);
}
