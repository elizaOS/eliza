/**
 * Keyless coverage exercising the coding-tools action execution surface end to
 * end. Runs on the pr-deterministic lane under the model provider.
 */
import { execFile } from "node:child_process";
import { promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { stringToUuid } from "@elizaos/core";
import {
  type RuntimeWithScenarioModelFixtures,
  registerStrictActionRouteFixtures,
} from "@elizaos/core/testing";
import type {
  CapturedAction,
  ScenarioContext,
  ScenarioModelFixture,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import codingToolsPlugin from "../../../../plugins/plugin-coding-tools/src/index.ts";

const execFileAsync = promisify(execFile);

const scenarioId = "deterministic-coding-tools-actions";
const tmpRoot = path.join(
  realpathSync(os.tmpdir()),
  "eliza-scenario-coding-tools",
);
const repoRoot = path.join(tmpRoot, "repo");
const blockedRoot = path.join(tmpRoot, "_blocked");
const notePath = path.join(repoRoot, "notes", "scenario-note.txt");
const worktreePath = path.join(
  tmpRoot,
  "worktrees",
  "scenario-coding-worktree",
);
const worktreeBranch = "scenario-coding-tools-branch";
const roomId = stringToUuid(`scenario-room:${scenarioId}:main`);
const worldId = stringToUuid(`scenario-runner-world:${scenarioId}`);
const userId = stringToUuid(
  `scenario-account:scenario-user:${scenarioId}:main`,
);

const writeParameters = {
  action: "write",
  file_path: notePath,
  content: "alpha coding-tools scenario\nbeta strict e2e\n",
};

const readParameters = {
  action: "read",
  file_path: notePath,
};

const shellParameters = {
  action: "run",
  command:
    "printf 'shell-ok:%s\\n' \"$(cat notes/scenario-note.txt | wc -l | tr -d ' ')\"",
  cwd: repoRoot,
  timeout: 10_000,
};

const enterWorktreeParameters = {
  action: "enter",
  name: worktreeBranch,
  path: worktreePath,
  base: "HEAD",
};

const exitWorktreeParameters = {
  action: "exit",
  cleanup: true,
};

const strictCodingToolRoutes = [
  {
    actionName: "FILE",
    args: writeParameters,
    contextIds: ["code"],
    input: "Write the deterministic coding tools note file",
    messageToUser: `Wrote ${notePath}`,
  },
  {
    actionName: "FILE",
    args: readParameters,
    contextIds: ["code"],
    input: "Read the deterministic coding tools note file",
    messageToUser: "alpha coding-tools scenario",
  },
  {
    actionName: "SHELL",
    args: shellParameters,
    contextIds: ["terminal"],
    input:
      "Run a shell command to count the deterministic coding tools note lines",
    messageToUser: "shell-ok:2",
  },
  {
    actionName: "WORKTREE",
    args: enterWorktreeParameters,
    contextIds: ["code"],
    input: "Enter an isolated repo worktree",
    messageToUser: `Entered worktree ${worktreeBranch}`,
  },
  {
    actionName: "WORKTREE",
    args: exitWorktreeParameters,
    contextIds: ["code"],
    input: "Exit and clean up the isolated repo worktree",
    messageToUser: "Exited and removed worktree",
  },
];

const plannerToolNames: Record<string, readonly string[]> = {
  FILE: ["FILE", "WEB_FETCH", "REPLY", "IGNORE", "STOP"],
  SHELL: ["SHELL", "WEB_FETCH", "REPLY", "IGNORE", "STOP"],
  WORKTREE: ["SHELL", "WORKTREE", "REPLY", "IGNORE", "STOP"],
};

function currentTurnInputPattern(input: string): string {
  const escaped = input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `${escaped}(?![\\s\\S]*message:user:\\n)`;
}

const codingToolModelFixtures: ScenarioModelFixture[] = [
  ...strictCodingToolRoutes.flatMap((route) => {
    const slug = route.actionName.toLowerCase();
    const replyText = route.messageToUser;
    return [
      {
        name: `route-${slug}-stage1-${route.input}`,
        match: {
          modelType: "RESPONSE_HANDLER",
          input: { pattern: currentTurnInputPattern(route.input) },
          toolNames: ["HANDLE_RESPONSE"],
        },
        response: {
          json: {
            contexts: route.contextIds,
            intents: [route.input.toLowerCase()],
            replyText,
            threadOps: [],
            candidateActionNames: [route.actionName],
          },
        },
      },
      {
        name: `route-${slug}-planner-${route.input}`,
        match: {
          modelType: "ACTION_PLANNER",
          input: { pattern: currentTurnInputPattern(route.input) },
          toolNames: plannerToolNames[route.actionName],
        },
        response: {
          json: {
            text: "",
            thought: `Call ${route.actionName} for ${route.input}.`,
            messageToUser: replyText,
            completed: true,
            finishReason: "tool-calls",
            toolCalls: [
              {
                id: `call-${slug}`,
                name: route.actionName,
                type: "function",
                arguments: route.args,
              },
            ],
          },
        },
      },
    ];
  }),
  {
    name: "post-tool-reply-exit-worktree",
    match: {
      modelType: "ACTION_PLANNER",
      input: {
        pattern: currentTurnInputPattern(
          "Exit and clean up the isolated repo worktree",
        ),
      },
      toolNames: [],
    },
    response: {
      json: {
        thought: "Report the completed worktree cleanup.",
        messageToUser: "Exited and removed worktree",
        completed: true,
        finishReason: "stop",
        toolCalls: [],
      },
    },
  },
  {
    name: "tool-result-rescue-exit-worktree",
    match: {
      modelType: "TEXT_LARGE",
      input: { includes: "Exited and removed worktree " },
      toolNames: [],
    },
    response: { text: "Exited and removed worktree" },
  },
];

let previousEvaluators: unknown[] | null = null;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function actionParameters(action: CapturedAction): JsonRecord {
  return isRecord(action.parameters) ? action.parameters : {};
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function expectEqual(
  actual: unknown,
  expected: unknown,
  label: string,
): string | undefined {
  const actualJson = stableStringify(actual);
  const expectedJson = stableStringify(expected);
  return actualJson === expectedJson
    ? undefined
    : `expected ${label}=${expectedJson}, saw ${actualJson}`;
}

function firstAction(
  execution: ScenarioTurnExecution,
  actionName: string,
): CapturedAction | string {
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === actionName,
  );
  return (
    action ??
    `expected ${actionName} action, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`
  );
}

function actionData(action: CapturedAction): JsonRecord | string {
  const data = action.result?.data;
  return isRecord(data)
    ? data
    : `expected ActionResult.data object, saw ${stableStringify(data)}`;
}

function expectSuccess(action: CapturedAction): string | undefined {
  return action.result?.success === true
    ? undefined
    : `expected ActionResult.success=true, saw ${stableStringify(action.result)}`;
}

function expectActionOptions(
  action: CapturedAction,
  expectedParameters: JsonRecord,
): string | undefined {
  const actual = actionParameters(action);
  if (
    !expectEqual(
      actual,
      expectedParameters,
      `${action.actionName} handler options`,
    )
  ) {
    return undefined;
  }
  const nested = isRecord(actual.parameters) ? actual.parameters : null;
  if (
    nested &&
    !expectEqual(
      nested,
      expectedParameters,
      `${action.actionName} nested handler parameters`,
    )
  ) {
    return undefined;
  }
  return `expected ${action.actionName} handler parameters to include ${stableStringify(expectedParameters)}, saw ${stableStringify(actual)}`;
}

function expectFileWriteTurn(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = firstAction(execution, "FILE");
  if (typeof action === "string") return action;
  return (
    expectActionOptions(action, writeParameters) ??
    expectSuccess(action) ??
    (() => {
      const data = actionData(action);
      if (typeof data === "string") return data;
      if (data.path !== notePath) {
        return `expected FILE write path=${notePath}, saw ${String(data.path)}`;
      }
      return typeof data.bytes === "number" && data.bytes > 0
        ? undefined
        : `expected FILE write byte count, saw ${stableStringify(data.bytes)}`;
    })()
  );
}

function expectFileReadTurn(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = firstAction(execution, "FILE");
  if (typeof action === "string") return action;
  return (
    expectActionOptions(action, readParameters) ??
    expectSuccess(action) ??
    (() => {
      const data = actionData(action);
      if (typeof data === "string") return data;
      const readView = isRecord(data.readView) ? data.readView : null;
      const reference = isRecord(readView?.reference)
        ? readView.reference
        : null;
      const slice = isRecord(readView?.slice) ? readView.slice : null;
      const range = isRecord(slice?.range) ? slice.range : null;
      if (reference?.kind !== "file") {
        return `expected FILE ReadView file reference, saw ${stableStringify(reference)}`;
      }
      if (
        range?.unit !== "line" ||
        range.start !== 0 ||
        range.end !== 2 ||
        range.total !== 2
      ) {
        return `expected FILE line range [0,2)/2, saw ${stableStringify(range)}`;
      }
      if (
        JSON.stringify(action.result?.data).includes(
          "alpha coding-tools scenario",
        )
      ) {
        return "expected FILE page text only in ActionResult.text, but data duplicated it";
      }
      return action.result?.text?.includes("alpha coding-tools scenario")
        ? undefined
        : `expected read text to include note content, saw ${JSON.stringify(action.result?.text)}`;
    })()
  );
}

function expectShellTurn(execution: ScenarioTurnExecution): string | undefined {
  const action = firstAction(execution, "SHELL");
  if (typeof action === "string") return action;
  return (
    expectActionOptions(action, shellParameters) ??
    expectSuccess(action) ??
    (() => {
      const data = actionData(action);
      if (typeof data === "string") return data;
      if (data.cwd !== repoRoot) {
        return `expected SHELL cwd=${repoRoot}, saw ${String(data.cwd)}`;
      }
      if (data.exit_code !== 0) {
        return `expected SHELL exit_code=0, saw ${String(data.exit_code)}`;
      }
      return action.result?.text?.includes("shell-ok:2")
        ? undefined
        : `expected shell stdout shell-ok:2, saw ${JSON.stringify(action.result?.text)}`;
    })()
  );
}

function expectWorktreeEnterTurn(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = firstAction(execution, "WORKTREE");
  if (typeof action === "string") return action;
  return (
    expectActionOptions(action, enterWorktreeParameters) ??
    expectSuccess(action) ??
    (() => {
      const data = actionData(action);
      if (typeof data === "string") return data;
      if (data.worktreePath !== worktreePath) {
        return `expected worktreePath=${worktreePath}, saw ${String(data.worktreePath)}`;
      }
      return data.branch === worktreeBranch
        ? undefined
        : `expected branch=${worktreeBranch}, saw ${String(data.branch)}`;
    })()
  );
}

function expectWorktreeExitTurn(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = firstAction(execution, "WORKTREE");
  if (typeof action === "string") return action;
  return (
    expectActionOptions(action, exitWorktreeParameters) ??
    expectSuccess(action) ??
    (() => {
      const data = actionData(action);
      if (typeof data === "string") return data;
      if (data.exited !== worktreePath) {
        return `expected exited=${worktreePath}, saw ${String(data.exited)}`;
      }
      if (data.restoredTo !== repoRoot) {
        return `expected restoredTo=${repoRoot}, saw ${String(data.restoredTo)}`;
      }
      return data.cleaned === true
        ? undefined
        : `expected cleaned=true, saw ${String(data.cleaned)}`;
    })()
  );
}

async function seedGitRepo(): Promise<void> {
  await fs.rm(tmpRoot, { force: true, recursive: true });
  await fs.mkdir(path.join(repoRoot, "notes"), { recursive: true });
  await fs.mkdir(blockedRoot, { recursive: true });
  await fs.writeFile(path.join(repoRoot, "README.md"), "scenario repo\n");
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await execFileAsync(
    "git",
    ["config", "user.email", "scenario@example.test"],
    {
      cwd: repoRoot,
    },
  );
  await execFileAsync("git", ["config", "user.name", "Scenario Runner"], {
    cwd: repoRoot,
  });
  await execFileAsync("git", ["add", "README.md"], { cwd: repoRoot });
  await execFileAsync("git", ["commit", "-m", "initial scenario commit"], {
    cwd: repoRoot,
  });
}

async function finalLedgerCheck(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const calls = ctx.actionsCalled ?? [];
  const names = calls.map((call) => call.actionName);
  const orderFailure = expectEqual(
    names,
    ["FILE", "FILE", "SHELL", "WORKTREE", "WORKTREE"],
    "coding-tools action order",
  );
  if (orderFailure) return orderFailure;
  const failed = calls.filter((call) => call.result?.success !== true);
  if (failed.length > 0) {
    return `expected every coding-tools action to succeed, saw ${stableStringify(failed)}`;
  }
  const content = await fs.readFile(notePath, "utf8");
  if (content !== writeParameters.content) {
    return `expected note content ${JSON.stringify(writeParameters.content)}, saw ${JSON.stringify(content)}`;
  }
  try {
    await fs.stat(worktreePath);
    return `expected cleanup to remove worktree path ${worktreePath}`;
  } catch {
    // missing is expected after WORKTREE exit cleanup.
  }
  await fs.rm(tmpRoot, { force: true, recursive: true });
  return undefined;
}

export default scenario({
  id: "deterministic-coding-tools-actions",
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "fixtures",
    fixtures: [...codingToolModelFixtures],
  },
  title: "Deterministic coding-tools action execution",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "zero-cost", "coding-tools"],
  isolation: "shared-runtime",
  requires: {
    plugins: ["@elizaos/plugin-coding-tools"],
  },
  seed: [
    {
      type: "custom",
      name: "seed isolated coding-tools git workspace",
      apply: async (ctx) => {
        await seedGitRepo();
        process.env.CODING_TOOLS_WORKSPACE_ROOTS = tmpRoot;
        process.env.CODING_TOOLS_BLOCKED_PATHS = blockedRoot;

        const runtime = ctx.runtime as
          | {
              plugins?: Array<{ name?: string }>;
              registerPlugin?: (
                plugin: typeof codingToolsPlugin,
              ) => Promise<void>;
              getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
              getService?: (serviceType: string) => unknown;
              ensureConnection?: (
                params: Record<string, unknown>,
              ) => Promise<void>;
              evaluators: unknown[];
            }
          | undefined;
        if (!runtime?.registerPlugin) {
          return "runtime.registerPlugin unavailable";
        }
        // Post-turn evaluators are outside the coding-tools execution contract.
        // Isolate them so every model call owned by this scenario is strict,
        // then restore the shared runtime in cleanup.
        previousEvaluators = runtime.evaluators;
        runtime.evaluators = [];
        if (
          !runtime.plugins?.some(
            (plugin) =>
              plugin.name === "coding-tools" ||
              plugin.name === "@elizaos/plugin-coding-tools",
          )
        ) {
          await runtime.registerPlugin(codingToolsPlugin);
        }
        await Promise.all([
          runtime.getServiceLoadPromise?.("CODING_TOOLS_SESSION_CWD"),
          runtime.getServiceLoadPromise?.("CODING_TOOLS_SANDBOX"),
        ]);
        const session = runtime.getService?.("CODING_TOOLS_SESSION_CWD") as
          | { setCwd?: (conversationId: string, absPath: string) => void }
          | null
          | undefined;
        const sandbox = runtime.getService?.("CODING_TOOLS_SANDBOX") as
          | { addRoot?: (conversationId: string, absPath: string) => void }
          | null
          | undefined;
        if (typeof session?.setCwd !== "function") {
          return "coding-tools session cwd service unavailable";
        }
        if (typeof sandbox?.addRoot !== "function") {
          return "coding-tools sandbox service unavailable";
        }
        sandbox.addRoot(roomId, tmpRoot);
        session.setCwd(roomId, repoRoot);
        await runtime.ensureConnection?.({
          entityId: userId,
          roomId,
          worldId,
          userName: "Deterministic Coding Tools",
          source: "telegram",
          channelId: roomId,
          type: "DM",
          metadata: {
            ownership: { ownerId: userId },
            roles: { [userId]: "OWNER" },
          },
        });
        return undefined;
      },
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "restore shared runtime evaluators",
      apply: (ctx) => {
        const runtime = ctx.runtime as { evaluators: unknown[] };
        if (previousEvaluators !== null) {
          runtime.evaluators = previousEvaluators;
          previousEvaluators = null;
        }
      },
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Deterministic Coding Tools",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "write scenario file",
      text: "Write the deterministic coding tools note file",
      responseIncludesAny: ["Wrote", notePath],
      assertTurn: expectFileWriteTurn,
    },
    {
      kind: "message",
      name: "read scenario file",
      text: "Read the deterministic coding tools note file",
      responseIncludesAny: ["alpha coding-tools scenario"],
      assertTurn: expectFileReadTurn,
    },
    {
      kind: "message",
      name: "run shell in seeded repo",
      text: "Run a shell command to count the deterministic coding tools note lines",
      responseIncludesAny: ["shell-ok:2"],
      assertTurn: expectShellTurn,
    },
    {
      kind: "message",
      name: "enter isolated worktree",
      text: "Enter an isolated repo worktree",
      responseIncludesAny: ["Entered worktree", worktreeBranch],
      assertTurn: expectWorktreeEnterTurn,
    },
    {
      kind: "message",
      name: "exit isolated worktree",
      text: "Exit and clean up the isolated repo worktree",
      responseIncludesAny: ["Exited and removed worktree"],
      assertTurn: expectWorktreeExitTurn,
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "FILE",
      status: "success",
      minCount: 2,
    },
    {
      type: "actionCalled",
      actionName: "SHELL",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "WORKTREE",
      status: "success",
      minCount: 2,
    },
    {
      type: "selectedActionArguments",
      actionName: ["FILE", "SHELL", "WORKTREE"],
      includesAll: [
        /scenario-note\.txt/,
        /shell-ok/,
        /scenario-coding-tools-branch/,
        /cleanup/,
      ],
    },
    {
      type: "custom",
      name: "coding-tools action ledger and filesystem side effects are exact",
      predicate: finalLedgerCheck,
    },
  ],
});
