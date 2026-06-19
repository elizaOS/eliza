#!/usr/bin/env node
/**
 * Gated live smoke for the native ACP transport through AcpService.
 *
 * Run from plugins/plugin-agent-orchestrator after `bun run build`:
 *   RUN_LIVE_NATIVE_ACP=1 bun run test:e2e:native
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUN_FLAG = "RUN_LIVE_NATIVE_ACP";
const DEFAULT_AGENT = "codex";
const PROMPT =
  "What is 7 plus 8? Reply with exactly the number, no punctuation.";
const CLEANUP_TIMEOUT_MS = Number(
  process.env.LIVE_NATIVE_ACP_CLEANUP_TIMEOUT_MS ?? 5_000,
);

class SkippedSmoke extends Error {
  constructor(message) {
    super(message);
    this.name = "SkippedSmoke";
  }
}

async function main() {
  if (process.env[RUN_FLAG] !== "1") {
    throw new SkippedSmoke(`set ${RUN_FLAG}=1 to run`);
  }

  const agent = normalizeAgent(
    process.env.LIVE_NATIVE_ACP_AGENT ??
      process.env.ELIZA_LIVE_NATIVE_ACP_AGENT ??
      process.env.ELIZA_ACP_DEFAULT_AGENT ??
      DEFAULT_AGENT,
  );
  ensureAgentCommand(agent);

  const { AcpService } = await import("../../dist/node/index.node.js");
  const workdir = mkdtempSync(join(tmpdir(), `eliza-native-acp-${agent}-`));
  const agentPidsBefore = snapshotAgentPids(agent);
  const runtime = makeRuntime(agent);
  const service = new AcpService(runtime);
  const events = [];
  let sessionId;

  service.onSessionEvent((sid, name, data) => {
    events.push({ sid, name, data });
  });

  try {
    console.log(`native ACP service smoke: agent=${agent}`);
    console.log(`native ACP service smoke: workdir=${workdir}`);
    console.log(
      `native ACP service smoke: command=${redactCommand(commandFor(agent))}`,
    );

    await service.start();
    const spawned = await service.spawnSession({
      agentType: agent,
      workdir,
      approvalPreset: "permissive",
      timeoutMs: Number(process.env.LIVE_NATIVE_ACP_TIMEOUT_MS ?? 120_000),
    });
    sessionId = spawned.sessionId;

    const promptResult = await service.sendPrompt(sessionId, PROMPT, {
      timeoutMs: Number(process.env.LIVE_NATIVE_ACP_TIMEOUT_MS ?? 120_000),
    });
    const finalText = String(promptResult.finalText ?? "").trim();
    const taskCompletes = events.filter(
      (event) => event.name === "task_complete",
    );
    const completed = promptResult.stopReason === "end_turn";
    const finalTextValid = /(^|[^0-9])15([^0-9]|$)/.test(finalText);

    console.log("\n=== native ACP service smoke verdict ===");
    console.log(`task_complete events: ${taskCompletes.length}`);
    console.log(`stopReason: ${JSON.stringify(promptResult.stopReason)}`);
    console.log(`final text: ${JSON.stringify(finalText)}`);
    console.log(`final text contains 15: ${finalTextValid}`);

    if (!completed || !finalTextValid || taskCompletes.length === 0) {
      throw new Error(
        `native ACP service smoke failed: stopReason=${JSON.stringify(
          promptResult.stopReason,
        )}, taskCompleteEvents=${taskCompletes.length}, finalText=${JSON.stringify(
          finalText,
        )}`,
      );
    }

    console.log("\nNATIVE ACP SMOKE PASSED");
  } catch (err) {
    if (isSkippableFailure(err)) {
      throw new SkippedSmoke(summarizeFailure(err));
    }
    throw err;
  } finally {
    await withTimeout(
      (async () => {
        if (sessionId) {
          await service.closeSession(sessionId).catch(() => undefined);
        }
        await service.stop().catch(() => undefined);
      })(),
      CLEANUP_TIMEOUT_MS,
    ).catch(() => undefined);
    killNewAgentPids(agent, agentPidsBefore, "SIGTERM");
    await wait(500);
    killNewAgentPids(agent, agentPidsBefore, "SIGKILL");
    rmSync(workdir, { recursive: true, force: true });
  }
}

function makeRuntime(agent) {
  return {
    agentId: "native-acp-service-smoke",
    logger: {
      debug: () => {},
      info: () => {},
      warn: (...args) => console.warn("[warn]", ...args),
      error: (...args) => console.error("[error]", ...args),
    },
    getSetting: (key) => {
      if (key === "ELIZA_ACP_TRANSPORT") return "native";
      if (key === "ELIZA_ACP_DEFAULT_AGENT") return agent;
      if (key === "ELIZA_ACP_NO_TERMINAL") return "true";
      return process.env[key];
    },
  };
}

function normalizeAgent(value) {
  const agent = String(value).trim().toLowerCase();
  if (["codex", "claude", "opencode"].includes(agent)) return agent;
  throw new SkippedSmoke(
    `unsupported LIVE_NATIVE_ACP_AGENT=${JSON.stringify(value)}`,
  );
}

function ensureAgentCommand(agent) {
  if (agent === "codex") return;
  if (commandFor(agent)) return;
  throw new SkippedSmoke(
    `${agent} requires ${commandEnvName(agent)}; codex is the only default native smoke command`,
  );
}

function commandFor(agent) {
  return process.env[commandEnvName(agent)]?.trim() ?? "";
}

function commandEnvName(agent) {
  return `ELIZA_${agent.toUpperCase()}_ACP_COMMAND`;
}

function isSkippableFailure(err) {
  const text = `${err?.message ?? ""}\n${err?.stack ?? ""}`;
  return /auth_required|auth required|authenticate|authentication|not authenticated|log in|login|credential|api[_ -]?key|unauthori[sz]ed|401|command not found|not found|ENOENT|npm error|npx/i.test(
    text,
  );
}

function summarizeFailure(err) {
  const text = `${err?.message ?? ""}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  return cap(text || "native ACP command unavailable");
}

function redactCommand(command) {
  return (command || "(default)").replace(
    /(api[_-]?key|token|password|secret)=("[^"]+"|'[^']+'|\S+)/gi,
    "$1=<redacted>",
  );
}

function cap(text, max = 2000) {
  return text.length > max ? text.slice(text.length - max) : text;
}

function snapshotAgentPids(agent) {
  const pattern = agentProcessPattern(agent);
  if (!pattern || process.platform === "win32") return new Set();
  try {
    const output = execFileSync("ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
    });
    const pids = output
      .split("\n")
      .map((line) => line.trim())
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.+)$/);
        if (!match) return undefined;
        const pid = Number(match[1]);
        const command = match[2] ?? "";
        return pattern.test(command) ? pid : undefined;
      })
      .filter((pid) => pid && pid !== process.pid);
    return new Set(pids);
  } catch {
    return new Set();
  }
}

function killNewAgentPids(agent, before, signal) {
  const current = snapshotAgentPids(agent);
  for (const pid of current) {
    if (before.has(pid)) continue;
    try {
      process.kill(pid, signal);
    } catch {
      // Best-effort cleanup for a gated live smoke.
    }
  }
}

function agentProcessPattern(agent) {
  if (agent === "codex") return /codex-acp/i;
  if (agent === "claude") return /claude-agent-acp/i;
  if (agent === "opencode") return /opencode.*\bacp\b/i;
  return undefined;
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref?.();
    }),
  ]);
}

function wait(timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    if (err instanceof SkippedSmoke) {
      console.log(`NATIVE ACP SMOKE SKIPPED: ${err.message}`);
      process.exit(0);
    }
    console.error(err?.stack ?? err);
    process.exit(1);
  });
