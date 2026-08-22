#!/usr/bin/env bun
/**
 * Exercises the real AgentRuntime -> AcpService -> eliza-code-acp stack against
 * a live OpenAI-compatible model and emits a secret-free evidence bundle.
 * Each scenario uses an isolated git workspace and records both ACP activity
 * events and the child runtime's native model trajectories.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeAgent, shutdownAgent } from "../../src/lib/agent.ts";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "../..");
const repoRoot = resolve(packageRoot, "../../..");
const acpEntry = join(packageRoot, "dist", "acp.js");
const apiKey = process.env.ELIZA_LIVE_QA_OPENROUTER_KEY?.trim();
const model = process.env.ELIZA_LIVE_QA_MODEL?.trim() || "qwen/qwen3.8-27b";
const keepArtifacts = process.env.ELIZA_LIVE_QA_KEEP === "1";
const timeoutMs = Number(process.env.ELIZA_LIVE_QA_TIMEOUT_MS || "300000");

if (!apiKey) {
  throw new Error(
    "ELIZA_LIVE_QA_OPENROUTER_KEY is required; pass it through the environment without writing it to the repository.",
  );
}
if (!existsSync(acpEntry)) {
  throw new Error(
    `Missing ${acpEntry}; run \`bun run build\` in ${packageRoot}.`,
  );
}
if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
  throw new Error("ELIZA_LIVE_QA_TIMEOUT_MS must be a positive number");
}

const testRoot = realpathSync(
  mkdtempSync(join(tmpdir(), "eliza-owned-runtime-live-")),
);
const runtimeHome = join(testRoot, "runtime");
const workspacesRoot = join(testRoot, "workspaces");
mkdirSync(runtimeHome, { recursive: true });
mkdirSync(workspacesRoot, { recursive: true });

Object.assign(process.env, {
  ELIZA_HOME: runtimeHome,
  ELIZA_STATE_DIR: join(runtimeHome, "state"),
  ELIZA_ACP_STATE_DIR: join(runtimeHome, "acp"),
  ELIZA_ACP_TRANSPORT: "native",
  ELIZA_ACP_DEFAULT_AGENT: "elizaos",
  ELIZA_ACP_WORKSPACE_ROOT: workspacesRoot,
  ELIZA_ELIZAOS_ACP_COMMAND: `bun ${acpEntry}`,
  ELIZA_CODE_PROVIDER: "openai",
  OPENAI_API_KEY: apiKey,
  OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
  OPENAI_LARGE_MODEL: model,
  OPENAI_SMALL_MODEL: model,
  ELIZA_TRAJECTORY_LOGGING: "1",
  ELIZA_TRAJECTORY_REVIEW_MODE: "1",
  ELIZA_ALLOW_DEFAULT_SECRET_SALT: "1",
  SECRET_SALT: "owned-runtime-live-qa",
});

const allScenarios = [
  {
    id: "inspect_without_writes",
    files: {
      "README.md":
        "# Inventory\n\nThere are 3 active widgets: amber, cobalt, and jade.\n",
      "src/inventory.js":
        'export const widgets = ["amber", "cobalt", "jade"];\n',
    },
    prompt:
      "Inspect README.md and src/inventory.js. Do not modify any files. Report the number of widgets and their names, then stop.",
    verify(workdir, before) {
      const after = snapshotFiles(workdir);
      return {
        passed:
          JSON.stringify(after) === JSON.stringify(before) &&
          readFileSync(join(workdir, "src/inventory.js"), "utf8").includes(
            '"jade"',
          ),
        checks: {
          workspaceUnchanged: JSON.stringify(after) === JSON.stringify(before),
          sourceStillReadable: true,
        },
      };
    },
  },
  {
    id: "fix_bug_and_run_tests",
    files: {
      "package.json":
        '{"name":"owned-live-fix","type":"module","scripts":{"test":"bun test"}}\n',
      "src/math.js": "export function add(a, b) {\n  return a - b;\n}\n",
      "src/math.test.js":
        'import { expect, test } from "bun:test";\nimport { add } from "./math.js";\n\ntest("adds positive and negative numbers", () => {\n  expect(add(7, 5)).toBe(12);\n  expect(add(-2, 5)).toBe(3);\n});\n',
    },
    prompt:
      "Fix the bug in src/math.js so the existing tests pass. Run the tests, make only the necessary source change, and report the test result.",
    verify(workdir) {
      const testRun = spawnSync("bun", ["test"], {
        cwd: workdir,
        encoding: "utf8",
      });
      const testOutput = `${testRun.stdout || ""}${testRun.stderr || ""}`;
      const changed = gitChangedPaths(workdir);
      const source = readFileSync(join(workdir, "src/math.js"), "utf8");
      return {
        passed:
          testRun.status === 0 &&
          /return\s+a\s*\+\s*b/.test(source) &&
          changed.length === 1 &&
          changed[0] === "src/math.js",
        checks: {
          independentTestExit: testRun.status,
          independentTestSummary: compactTestOutput(testOutput),
          exactChangedPaths: changed,
          additionImplemented: /return\s+a\s*\+\s*b/.test(source),
        },
      };
    },
  },
  {
    id: "create_feature_with_tests",
    files: {
      "package.json":
        '{"name":"owned-live-feature","type":"module","scripts":{"test":"bun test"}}\n',
      "README.md":
        "# Slug utility\n\nAdd a small tested slugify utility under src/.\n",
    },
    prompt:
      "Implement src/slugify.js exporting slugify(value). It must lowercase text, trim it, replace runs of non-alphanumeric characters with one hyphen, and remove leading/trailing hyphens. Add src/slugify.test.js with useful edge cases and run bun test. Do not add dependencies. Report files and test results.",
    verify(workdir) {
      const behaviorRun = spawnSync(
        "bun",
        [
          "-e",
          'import { slugify } from "./src/slugify.js"; const got=[slugify("  Hello, WORLD!  "),slugify("already---clean"),slugify("***")]; if(JSON.stringify(got)!==JSON.stringify(["hello-world","already-clean",""])) throw new Error(JSON.stringify(got)); console.log(JSON.stringify(got));',
        ],
        { cwd: workdir, encoding: "utf8" },
      );
      const testRun = spawnSync("bun", ["test"], {
        cwd: workdir,
        encoding: "utf8",
      });
      const testOutput = `${testRun.stdout || ""}${testRun.stderr || ""}`;
      const changed = gitChangedPaths(workdir);
      const expected = ["src/slugify.js", "src/slugify.test.js"];
      return {
        passed:
          behaviorRun.status === 0 &&
          testRun.status === 0 &&
          expected.every((path) => changed.includes(path)) &&
          changed.every((path) => expected.includes(path)),
        checks: {
          independentBehavior:
            behaviorRun.status === 0
              ? JSON.parse(behaviorRun.stdout.trim())
              : behaviorRun.stderr.trim(),
          independentTestExit: testRun.status,
          independentTestSummary: compactTestOutput(testOutput),
          exactChangedPaths: changed,
          noDependenciesAdded: !changed.includes("package.json"),
        },
      };
    },
  },
];
const requestedScenarioIds = new Set(
  (process.env.ELIZA_LIVE_QA_SCENARIOS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const knownScenarioIds = new Set(allScenarios.map((scenario) => scenario.id));
const unknownScenarioIds = [...requestedScenarioIds].filter(
  (id) => !knownScenarioIds.has(id),
);
if (unknownScenarioIds.length > 0) {
  throw new Error(
    `Unknown ELIZA_LIVE_QA_SCENARIOS: ${unknownScenarioIds.join(", ")}`,
  );
}
const scenarios =
  requestedScenarioIds.size === 0
    ? allScenarios
    : allScenarios.filter((scenario) => requestedScenarioIds.has(scenario.id));
if (scenarios.length === 0) {
  throw new Error("ELIZA_LIVE_QA_SCENARIOS did not match a known scenario");
}

function compactTestOutput(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /pass|fail|test/i.test(line))
    .slice(-4)
    .join(" | ");
}

function listFiles(root, current = root) {
  if (!existsSync(current)) return [];
  return readdirSync(current, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.name === ".git") return [];
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) return listFiles(root, absolute);
      if (!entry.isFile()) return [];
      return [relative(root, absolute)];
    })
    .sort();
}

function snapshotFiles(root) {
  return Object.fromEntries(
    listFiles(root).map((path) => [
      path,
      readFileSync(join(root, path), "utf8"),
    ]),
  );
}

function gitChangedPaths(workdir) {
  return execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: workdir,
      encoding: "utf8",
    },
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .sort();
}

function initializeFixture(scenario, workdir) {
  mkdirSync(workdir, { recursive: true });
  const operatingManual =
    "# Live QA fixture\n\nWork only inside this fixture. Do not commit. Run requested tests and report their real results.\n";
  writeFileSync(join(workdir, "AGENTS.md"), operatingManual, "utf8");
  writeFileSync(join(workdir, "CLAUDE.md"), operatingManual, "utf8");
  for (const [path, content] of Object.entries(scenario.files)) {
    const absolute = join(workdir, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
  execFileSync("git", ["init", "-q"], { cwd: workdir });
  execFileSync("git", ["config", "user.email", "live-qa@eliza.test"], {
    cwd: workdir,
  });
  execFileSync("git", ["config", "user.name", "eliza-live-qa"], {
    cwd: workdir,
  });
  execFileSync("git", ["add", "."], { cwd: workdir });
  execFileSync("git", ["commit", "-qm", "fixture baseline"], { cwd: workdir });
}

function sanitizeString(value) {
  return value
    .split(apiKey)
    .join("<redacted-api-key>")
    .split(testRoot)
    .join("<test-root>")
    .split(repoRoot)
    .join("<repo-root>")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>");
}

function sanitize(value, depth = 0) {
  if (depth > 12) return "<depth-limit>";
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value))
    return value.map((entry) => sanitize(entry, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sanitize(entry, depth + 1),
      ]),
    );
  }
  return value;
}

function projectEvent(event, data) {
  if (!data || typeof data !== "object") return { event, data: sanitize(data) };
  if (event === "tool_running") {
    const tool = data.toolCall || {};
    return {
      event,
      tool: sanitize({
        id: tool.id,
        title: tool.title,
        kind: tool.kind,
        status: tool.status,
        rawInput: tool.rawInput,
        locations: tool.locations,
        output: tool.output,
      }),
    };
  }
  if (event === "message" || event === "reasoning") {
    return {
      event,
      text: sanitizeString(String(data.text || "")),
    };
  }
  if (event === "task_complete") {
    return {
      event,
      response: sanitizeString(String(data.response || "")),
      durationMs: data.durationMs,
      stopReason: data.stopReason,
    };
  }
  return { event, data: sanitize(data) };
}

function readTrajectoryEvidence(trajectoryDir) {
  const jsonFiles = listFiles(trajectoryDir).filter((path) =>
    path.endsWith(".json"),
  );
  return jsonFiles.map((path) => {
    const parsed = JSON.parse(readFileSync(join(trajectoryDir, path), "utf8"));
    const stages = Array.isArray(parsed.stages) ? parsed.stages : [];
    return sanitize({
      file: path,
      trajectoryId: parsed.trajectoryId,
      status: parsed.status,
      startedAt: parsed.startedAt,
      completedAt: parsed.completedAt,
      stageCount: stages.length,
      stages: stages.map((stage) => ({
        kind: stage.kind,
        name: stage.name,
        model: stage.model
          ? {
              modelType: stage.model.modelType,
              modelName: stage.model.modelName,
              provider: stage.model.provider,
              prompt: stage.model.prompt,
              messages: stage.model.messages,
              response: stage.model.response,
              toolCalls: stage.model.toolCalls,
              usage: stage.model.usage,
              finishReason: stage.model.finishReason,
            }
          : undefined,
        tool: stage.tool
          ? {
              name: stage.tool.name,
              args: stage.tool.args,
              result: stage.tool.result,
              success: stage.tool.success,
              durationMs: stage.tool.durationMs,
              input: stage.tool.input,
              output: stage.tool.output,
              error: stage.tool.error,
            }
          : undefined,
      })),
    });
  });
}

function waitForTerminal(sessionId, eventLog) {
  const terminal = new Set(["task_complete", "error", "cancelled", "stopped"]);
  return new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const event = eventLog.find(
        (entry) => entry.sessionId === sessionId && terminal.has(entry.event),
      );
      if (event) {
        clearInterval(timer);
        resolvePromise(event);
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(
          new Error(`Timed out waiting for terminal event in ${sessionId}`),
        );
      }
    }, 100);
  });
}

let runtime;
let acp;
let unsubscribe;
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  stack: ["AgentRuntime", "AcpService", "native ACP", "eliza-code-acp"],
  provider: "OpenRouter via @elizaos/plugin-openai",
  model,
  repoHead: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim(),
  credentialHandling:
    "The key was accepted only through process environment, redacted recursively, and never included in this report.",
  scenarios: [],
};

try {
  runtime = await initializeAgent({ loadDotenv: false });
  acp = await runtime.getServiceLoadPromise("ACP_SUBPROCESS_SERVICE");
  const rawEvents = [];
  unsubscribe = acp.onSessionEvent((sessionId, event, data) => {
    rawEvents.push({ sessionId, event, data, at: new Date().toISOString() });
  });

  for (const scenario of scenarios) {
    const workdir = join(workspacesRoot, scenario.id);
    const trajectoryDir = join(testRoot, "trajectories", scenario.id);
    const startedAt = Date.now();
    let spawned;
    try {
      initializeFixture(scenario, workdir);
      const before = snapshotFiles(workdir);
      spawned = await acp.spawnSession({
        name: `owned-live-${scenario.id}`,
        agentType: "elizaos",
        workdir,
        approvalPreset: "permissive",
        initialTask: scenario.prompt,
        timeoutMs,
        env: {
          ELIZA_TRAJECTORY_LOGGING: "1",
          ELIZA_TRAJECTORY_REVIEW_MODE: "1",
          ELIZA_TRAJECTORY_DIR: trajectoryDir,
          PGLITE_DATA_DIR: join(testRoot, "pglite", scenario.id),
        },
        metadata: { keepAliveAfterComplete: true, liveQaScenario: scenario.id },
      });
      const terminal = await waitForTerminal(spawned.sessionId, rawEvents);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      const verification = scenario.verify(workdir, before);
      const events = rawEvents
        .filter((entry) => entry.sessionId === spawned.sessionId)
        .map((entry) => ({
          at: entry.at,
          ...projectEvent(entry.event, entry.data),
        }));
      const response =
        terminal.data && typeof terminal.data === "object"
          ? String(terminal.data.response || terminal.data.message || "")
          : "";
      const trajectories = readTrajectoryEvidence(trajectoryDir);
      const failedTools = trajectories.flatMap((trajectory) =>
        trajectory.stages
          .filter((stage) => stage.tool && stage.tool.success !== true)
          .map((stage) => ({
            name: stage.tool.name,
            args: stage.tool.args,
            result: stage.tool.result,
            error: stage.tool.error,
          })),
      );
      report.scenarios.push({
        id: scenario.id,
        prompt: scenario.prompt,
        durationMs: Date.now() - startedAt,
        session: {
          agentType: spawned.agentType,
          spawnStatus: spawned.status,
          terminalEvent: terminal.event,
        },
        response: sanitizeString(response),
        verification,
        workspace: {
          files: listFiles(workdir),
          changedPaths: gitChangedPaths(workdir),
        },
        events,
        trajectories,
        trajectoryHealth: {
          toolCallCount: trajectories.reduce(
            (count, trajectory) =>
              count + trajectory.stages.filter((stage) => stage.tool).length,
            0,
          ),
          failedToolCallCount: failedTools.length,
          failedTools,
        },
        passed:
          terminal.event === "task_complete" &&
          verification.passed &&
          trajectories.length > 0,
      });
    } catch (error) {
      // error-policy:J1 scenario failures become inspectable report entries.
      const capturedTrajectories = readTrajectoryEvidence(trajectoryDir);
      const capturedToolStages = capturedTrajectories.flatMap((trajectory) =>
        trajectory.stages.filter((stage) => stage.tool),
      );
      const capturedFailedTools = capturedToolStages
        .filter((stage) => stage.tool.success !== true)
        .map((stage) => ({
          name: stage.tool.name,
          args: stage.tool.args,
          result: stage.tool.result,
          error: stage.tool.error,
        }));
      report.scenarios.push({
        id: scenario.id,
        prompt: scenario.prompt,
        durationMs: Date.now() - startedAt,
        session: spawned
          ? { agentType: spawned.agentType, spawnStatus: spawned.status }
          : null,
        response: "",
        verification: { passed: false, checks: {} },
        workspace: {
          files: listFiles(workdir),
          changedPaths: existsSync(join(workdir, ".git"))
            ? gitChangedPaths(workdir)
            : [],
        },
        events: spawned
          ? rawEvents
              .filter((entry) => entry.sessionId === spawned.sessionId)
              .map((entry) => ({
                at: entry.at,
                ...projectEvent(entry.event, entry.data),
              }))
          : [],
        trajectories: capturedTrajectories,
        trajectoryHealth: {
          toolCallCount: capturedToolStages.length,
          failedToolCallCount: capturedFailedTools.length,
          failedTools: capturedFailedTools,
        },
        error: sanitizeString(
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
        ),
        passed: false,
      });
    } finally {
      if (spawned) {
        try {
          await acp.closeSession(spawned.sessionId);
        } catch (error) {
          // error-policy:J6 session shutdown is best-effort after evidence capture.
          console.warn(`Failed to close live QA session: ${String(error)}`);
        }
      }
    }
  }
  unsubscribe();
  unsubscribe = undefined;
  report.passed = report.scenarios.every((scenario) => scenario.passed);
  report.summary = {
    scenarioCount: report.scenarios.length,
    passedCount: report.scenarios.filter((scenario) => scenario.passed).length,
    totalAcpEvents: report.scenarios.reduce(
      (sum, scenario) => sum + scenario.events.length,
      0,
    ),
    totalNativeTrajectories: report.scenarios.reduce(
      (sum, scenario) => sum + scenario.trajectories.length,
      0,
    ),
  };
  console.log("OWNED_RUNTIME_LIVE_QA_BEGIN");
  console.log(JSON.stringify(report, null, 2));
  console.log("OWNED_RUNTIME_LIVE_QA_END");
  if (!report.passed) process.exitCode = 1;
} finally {
  if (unsubscribe) unsubscribe();
  if (runtime) {
    try {
      await shutdownAgent(runtime);
    } catch (error) {
      // error-policy:J6 runtime shutdown must not hide the scenario verdict.
      console.warn(`Failed to shut down live QA runtime: ${String(error)}`);
    }
  }
  if (keepArtifacts) {
    console.error(`Kept live QA artifacts at ${testRoot}`);
  } else {
    rmSync(testRoot, { recursive: true, force: true });
  }
  // Bun's PGlite/Emscripten adapter can set 99 during clean shutdown even after
  // all assertions pass. Preserve real failures, but neutralize only that known
  // teardown code after a fully passing report.
  if (report.passed && process.exitCode === 99) process.exitCode = 0;
}
