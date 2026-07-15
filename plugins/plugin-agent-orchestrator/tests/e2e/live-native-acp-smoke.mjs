#!/usr/bin/env node
/**
 * Gated live smoke for the native ACP transport through AcpService.
 *
 * Run from plugins/plugin-agent-orchestrator after `bun run build`:
 *   RUN_LIVE_NATIVE_ACP=1 bun run test:e2e:native
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUN_FLAG = "RUN_LIVE_NATIVE_ACP";
const DIFF_GATE_EVIDENCE =
  process.env.LIVE_NATIVE_ACP_DIFF_GATE_EVIDENCE === "1";
const DEFAULT_AGENT = "codex";
const DEFAULT_CODEX_MODEL =
  process.env.LIVE_NATIVE_ACP_CODEX_MODEL ?? "gpt-5.5";
const DEFAULT_CODEX_REASONING_EFFORT =
  process.env.LIVE_NATIVE_ACP_CODEX_REASONING_EFFORT ?? "low";
const DEFAULT_CODEX_COMMAND = "npx -y @agentclientprotocol/codex-acp@1.1.2";
const GIT_IDENTITY_EVIDENCE =
  process.env.LIVE_NATIVE_ACP_GIT_IDENTITY_EVIDENCE === "1";
const GIT_IDENTITY_PROMPT =
  "Create identity-proof.txt containing exactly `real ACP commit identity proof` followed by a newline. Commit it with the message `test: prove coding agent identity`. Do not read or change git configuration. Reply with the commit hash.";
const PROMPT = DIFF_GATE_EVIDENCE
  ? "Create package-lock.json containing exactly {\"lockfileVersion\":3} followed by a newline, commit it with message 'add generated lockfile', and report the commit hash. Do not change any other file."
  : "What is 7 plus 8? Reply with exactly the number, no punctuation.";
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
  if (GIT_IDENTITY_EVIDENCE && DIFF_GATE_EVIDENCE) {
    throw new Error("select only one native ACP evidence mode per run");
  }

  const agent = normalizeAgent(
    process.env.LIVE_NATIVE_ACP_AGENT ??
      process.env.ELIZA_LIVE_NATIVE_ACP_AGENT ??
      process.env.ELIZA_ACP_DEFAULT_AGENT ??
      DEFAULT_AGENT,
  );
  ensureAgentCommand(agent);

  const { AcpService, CodingWorkspaceService } = await import(
    "../../dist/node/index.node.js"
  );
  const workdir = mkdtempSync(join(tmpdir(), `eliza-native-acp-${agent}-`));
  if (DIFF_GATE_EVIDENCE) initializeEvidenceRepository(workdir);
  const codexHome =
    agent === "codex" ? createSmokeCodexHome(workdir) : undefined;
  const agentPidsBefore = snapshotAgentPids(agent);
  const runtime = makeRuntime(agent);
  const service = new AcpService(runtime);
  const events = [];
  const keepAlive = setInterval(() => undefined, 1_000);
  let sessionId;

  service.onSessionEvent((sid, name, data) => {
    events.push({ sid, name, data });
  });

  try {
    const smokeTimeoutMs = Number(
      process.env.LIVE_NATIVE_ACP_TIMEOUT_MS ?? 120_000,
    );
    console.log(`native ACP service smoke: agent=${agent}`);
    console.log(`native ACP service smoke: workdir=${workdir}`);
    console.log(
      `native ACP service smoke: command=${redactCommand(commandFor(agent))}`,
    );
    if (GIT_IDENTITY_EVIDENCE) {
      execFileSync("git", ["init", "--initial-branch=main"], {
        cwd: workdir,
        stdio: "pipe",
      });
      console.log(
        "native ACP service smoke: initialized identity evidence repo",
      );
    }

    await withTimeout(service.start(), smokeTimeoutMs);
    console.log("native ACP service smoke: service started");
    console.log("native ACP service smoke: spawning session");
    const spawnPromise = service.spawnSession({
      agentType: agent,
      workdir,
      approvalPreset: "permissive",
      timeoutMs: smokeTimeoutMs,
      ...(codexHome ? { env: { CODEX_HOME: codexHome } } : {}),
    });
    console.log("native ACP service smoke: spawn request submitted");
    const spawned = await withTimeout(spawnPromise, smokeTimeoutMs);
    sessionId = spawned.sessionId;
    console.log(
      `native ACP service smoke: session=${String(sessionId).slice(0, 8)}`,
    );

    const promptResult = await withTimeout(
      service.sendPrompt(
        sessionId,
        GIT_IDENTITY_EVIDENCE ? GIT_IDENTITY_PROMPT : PROMPT,
        {
          timeoutMs: smokeTimeoutMs,
        },
      ),
      smokeTimeoutMs,
    );
    console.log("native ACP service smoke: prompt completed");
    const finalText = String(promptResult.finalText ?? "").trim();
    const taskCompletes = events.filter(
      (event) => event.name === "task_complete",
    );
    const completed = promptResult.stopReason === "end_turn";
    const identityEvidence = GIT_IDENTITY_EVIDENCE
      ? readGitIdentityEvidence(workdir)
      : null;
    const finalTextValid = GIT_IDENTITY_EVIDENCE
      ? identityEvidence.valid
      : DIFF_GATE_EVIDENCE
        ? existsSync(join(workdir, "package-lock.json"))
        : /(^|[^0-9])15([^0-9]|$)/.test(finalText);

    console.log("\n=== native ACP service smoke verdict ===");
    console.log(`task_complete events: ${taskCompletes.length}`);
    console.log(`stopReason: ${JSON.stringify(promptResult.stopReason)}`);
    console.log(
      GIT_IDENTITY_EVIDENCE
        ? "final text: <suppressed; identity mode verifies Git directly>"
        : `final text: ${JSON.stringify(finalText)}`,
    );
    console.log(
      GIT_IDENTITY_EVIDENCE
        ? `git identity evidence valid: ${finalTextValid}`
        : DIFF_GATE_EVIDENCE
          ? `forbidden lockfile exists: ${finalTextValid}`
          : `final text contains 15: ${finalTextValid}`,
    );
    if (identityEvidence) {
      console.log("\n=== git identity domain artifact ===");
      console.log(identityEvidence.show);
      console.log(
        `identity-proof.txt: ${JSON.stringify(identityEvidence.file)}`,
      );
    }

    if (!completed || !finalTextValid || taskCompletes.length === 0) {
      const eventSummary = summarizeEvents(events);
      throw new Error(
        `native ACP service smoke failed: stopReason=${JSON.stringify(
          promptResult.stopReason,
        )}, taskCompleteEvents=${taskCompletes.length}, finalText=${JSON.stringify(
          finalText,
        )}, events=${eventSummary}`,
      );
    }

    if (DIFF_GATE_EVIDENCE) {
      await verifyDiffGateEvidence({
        CodingWorkspaceService,
        runtime,
        workdir,
      });
    }

    console.log("\nNATIVE ACP SMOKE PASSED");
  } catch (err) {
    if (isSkippableFailure(err)) {
      throw new SkippedSmoke(summarizeFailure(err));
    }
    throw err;
  } finally {
    console.log("native ACP service smoke: cleanup starting");
    if (sessionId) {
      await withTimeout(
        (async () => {
          await service.closeSession(sessionId).catch(() => undefined);
          await service.stop().catch(() => undefined);
        })(),
        CLEANUP_TIMEOUT_MS,
      ).catch(() => undefined);
      killNewAgentPids(agent, agentPidsBefore, "SIGTERM");
      await wait(500);
      killNewAgentPids(agent, agentPidsBefore, "SIGKILL");
    } else {
      console.warn(
        "native ACP service smoke: skipping process cleanup before session id",
      );
    }
    clearInterval(keepAlive);
    rmSync(workdir, { recursive: true, force: true });
    if (codexHome) rmSync(codexHome, { recursive: true, force: true });
    console.log("native ACP service smoke: cleanup complete");
  }
}

function readGitIdentityEvidence(workdir) {
  const expectedAuthorName =
    process.env.ELIZA_CODING_GIT_AUTHOR_NAME ?? "elizaOS Coding Agent";
  const expectedAuthorEmail =
    process.env.ELIZA_CODING_GIT_AUTHOR_EMAIL ??
    "coding-agent.no-reply@elizaos.local";
  const expectedCommitterName =
    process.env.ELIZA_CODING_GIT_COMMITTER_NAME ?? expectedAuthorName;
  const expectedCommitterEmail =
    process.env.ELIZA_CODING_GIT_COMMITTER_EMAIL ?? expectedAuthorEmail;
  const fields = execFileSync(
    "git",
    ["show", "-s", "--format=%H%n%an%n%ae%n%cn%n%ce%n%B", "HEAD"],
    { cwd: workdir, encoding: "utf8" },
  ).trimEnd();
  const [hash, authorName, authorEmail, committerName, committerEmail] =
    fields.split("\n");
  const file = readFileSync(join(workdir, "identity-proof.txt"), "utf8");
  return {
    valid:
      /^[0-9a-f]{40}$/u.test(hash ?? "") &&
      authorName === expectedAuthorName &&
      authorEmail === expectedAuthorEmail &&
      committerName === expectedCommitterName &&
      committerEmail === expectedCommitterEmail &&
      file === "real ACP commit identity proof\n",
    show: execFileSync("git", ["show", "-s", "--format=fuller", "HEAD"], {
      cwd: workdir,
      encoding: "utf8",
    }).trimEnd(),
    file,
  };
}

function initializeEvidenceRepository(workdir) {
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: workdir });
  execFileSync("git", ["config", "user.name", "elizaOS Evidence Host"], {
    cwd: workdir,
  });
  execFileSync("git", ["config", "user.email", "evidence-host@elizaos.local"], {
    cwd: workdir,
  });
  writeFileSync(join(workdir, "README.md"), "# Diff gate evidence\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: workdir });
  execFileSync("git", ["commit", "-m", "initial evidence baseline"], {
    cwd: workdir,
  });
}

async function verifyDiffGateEvidence({
  CodingWorkspaceService,
  runtime,
  workdir,
}) {
  const workspaceId = "live-diff-gate-evidence";
  const service = new CodingWorkspaceService({
    ...runtime,
    reportError: (scope, error) =>
      console.error(`[runtime.reportError] ${scope}: ${error.message}`),
  });
  let finalizerCalls = 0;
  service.workspaceService = {
    finalize: async () => {
      finalizerCalls += 1;
      throw new Error("finalizer must not be called for a prohibited diff");
    },
  };
  service.workspaces.set(workspaceId, {
    id: workspaceId,
    path: workdir,
    branch: "main",
    baseBranch: "main~1",
    isWorktree: false,
    repo: "https://github.com/elizaOS/evidence-only.git",
    status: "ready",
  });

  const events = [];
  service.onEvent((event) => events.push(event));
  let blocked;
  try {
    await service.createPR(workspaceId, {
      title: "Evidence-only prohibited diff",
      body: "This call must be rejected before finalization.",
    });
  } catch (error) {
    if (error?.name !== "DiffGateBlockedError") throw error;
    blocked = error;
  }
  if (!blocked) throw new Error("diff-review gate accepted a prohibited diff");
  const gateEvent = events.find(
    (event) => event.data?.diffGate?.outcome === "blocked",
  );
  if (!gateEvent) throw new Error("blocked diff-review event was not emitted");
  if (finalizerCalls !== 0) {
    throw new Error(`PR finalizer was called ${finalizerCalls} time(s)`);
  }

  console.log("\n=== live diff-review gate evidence ===");
  console.log(`agent commit: ${git(workdir, ["rev-parse", "HEAD"])}`);
  console.log(
    `changed files: ${git(workdir, ["diff", "--name-only", "main~1...HEAD"])}`,
  );
  console.log(`gate summary: ${blocked.message.replaceAll("\n", " | ")}`);
  console.log(`gate event: ${JSON.stringify(gateEvent.data.diffGate)}`);
  console.log(`PR finalizer calls: ${finalizerCalls}`);
}

function git(workdir, args) {
  return execFileSync("git", args, { cwd: workdir, encoding: "utf8" }).trim();
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
    getService: () => undefined,
    getSetting: (key) => {
      if (key === "ELIZA_ACP_TRANSPORT") return "native";
      if (key === "ELIZA_ACP_DEFAULT_AGENT") return agent;
      if (key === "ELIZA_ACP_NO_TERMINAL") return "true";
      if (key === "ELIZA_CODEX_ACP_COMMAND") {
        return process.env[key]?.trim() || DEFAULT_CODEX_COMMAND;
      }
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
  const command = process.env[commandEnvName(agent)]?.trim();
  if (command) return command;
  return agent === "codex" ? DEFAULT_CODEX_COMMAND : "";
}

function commandEnvName(agent) {
  return `ELIZA_${agent.toUpperCase()}_ACP_COMMAND`;
}

function createSmokeCodexHome(workdir) {
  const codexHome = mkdtempSync(join(tmpdir(), "eliza-native-acp-codex-home-"));
  writeFileSync(
    join(codexHome, "config.toml"),
    `model = ${JSON.stringify(DEFAULT_CODEX_MODEL)}\nmodel_reasoning_effort = ${JSON.stringify(
      DEFAULT_CODEX_REASONING_EFFORT,
    )}\n`,
    "utf8",
  );
  const authPath = join(process.env.HOME ?? "", ".codex", "auth.json");
  if (existsSync(authPath)) {
    symlinkSync(authPath, join(codexHome, "auth.json"));
  }
  writeFileSync(join(workdir, ".codex-home"), codexHome, "utf8");
  return codexHome;
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

function summarizeEvents(events) {
  return JSON.stringify(
    events.slice(-10).map((event) => ({
      name: event.name,
      data: redactEventData(event.data),
    })),
  );
}

function redactEventData(value) {
  const text = JSON.stringify(value ?? {});
  return redactCommand(cap(text, 800));
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
    if (pid === process.pid || pid === process.ppid) continue;
    if (before.has(pid)) continue;
    try {
      process.kill(pid, signal);
    } catch {
      // Best-effort teardown for a gated live smoke.
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
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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
