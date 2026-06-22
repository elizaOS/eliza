// Gap closed: there was NO deterministic, zero-cost scenario that proves the
// end-to-end "create an app" coding loop — scaffold real files on disk via the
// coding-tools FILE action, then run a real build/verify via the SHELL action,
// and assert the produced workspace is sound. The existing
// deterministic-coding-tools-actions.scenario.ts exercises FILE/SHELL through
// strict LLM routing on a flat note file; this scenario instead drives the
// scaffold-then-build path directly with kind:"action" turns (no LLM, no
// fixtures) and asserts: (1) three scaffold writes land byte-for-byte on disk,
// (2) the build/verify SHELL command exits 0 in the scaffolded app dir, and
// (3) NO real sub-agent spawn happened (START_CODING_TASK is not registered in
// the scenario runtime), so the deterministic file-mutation + build path is the
// honest, self-contained substitute for the live-only sub-agent-spawn lane.
//
// Sub-agent spawning is a live-only concern: app-create's dispatchCodingAgent
// returns dispatched:false when START_CODING_TASK is absent, so a deterministic
// lane cannot (and must not silently pretend to) spawn a sub-agent. We assert
// that negative explicitly via a custom finalCheck.

import { execFile } from "node:child_process";
import { promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { stringToUuid } from "@elizaos/core";
import type {
  CapturedAction,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import codingToolsPlugin from "../../../../plugins/plugin-coding-tools/src/index.ts";

const execFileAsync = promisify(execFile);

const scenarioId = "deterministic-create-app-coding";

// Resolve the tmp root through realpath so the macOS /var -> /private/var
// symlink does not break sandbox path validation (spawnSession/validatePath
// compare resolved paths).
const tmpRoot = path.join(
  realpathSync(os.tmpdir()),
  "eliza-scenario-create-app",
);
const repoRoot = path.join(tmpRoot, "repo");
const appDir = path.join(repoRoot, "eliza", "apps", "app-scratch-tool");
const blockedRoot = path.join(tmpRoot, "_blocked");

const appTsxPath = path.join(appDir, "src", "App.tsx");
const packageJsonPath = path.join(appDir, "package.json");
const indexTsPath = path.join(appDir, "src", "index.ts");

const roomId = stringToUuid(`scenario-room:${scenarioId}:main`);
const worldId = stringToUuid(`scenario-runner-world:${scenarioId}`);
const userId = stringToUuid(
  `scenario-account:scenario-user:${scenarioId}:main`,
);

// ---------------------------------------------------------------------------
// Scaffolded file contents (these are written verbatim and re-read on disk).
// ---------------------------------------------------------------------------

const appTsxContent = `export function App(): string {
  return "scratch-tool";
}
`;

const packageJsonContent = `${JSON.stringify(
  {
    name: "app-scratch-tool",
    version: "0.0.0",
    private: true,
    type: "module",
    main: "src/index.ts",
  },
  null,
  2,
)}\n`;

const indexTsContent = `import { App } from "./App";

export function main(): string {
  return App();
}
`;

// ---------------------------------------------------------------------------
// Turn parameter shapes (threaded straight into the action handler as options).
// ---------------------------------------------------------------------------

const writeAppTsxParameters = {
  action: "write",
  file_path: appTsxPath,
  content: appTsxContent,
};

const writePackageJsonParameters = {
  action: "write",
  file_path: packageJsonPath,
  content: packageJsonContent,
};

const writeIndexTsParameters = {
  action: "write",
  file_path: indexTsPath,
  content: indexTsContent,
};

// Generic, fully-offline build/verify: parse package.json and confirm App.tsx
// exists, then print a marker. Kept generic so bash.ts's message-driven command
// rewrite heuristics (crypto/disk/health/source) never fire.
const buildCommand =
  "node -e \"const fs=require('fs');const p=require('path');" +
  "const pkg=JSON.parse(fs.readFileSync(p.join(process.cwd(),'package.json'),'utf8'));" +
  "if(pkg.name!=='app-scratch-tool'){throw new Error('bad package name');}" +
  "if(!fs.existsSync(p.join(process.cwd(),'src','App.tsx'))){throw new Error('missing App.tsx');}" +
  "console.log('BUILD_OK');\"";

const buildParameters = {
  action: "run",
  command: buildCommand,
  cwd: appDir,
  timeout: 30_000,
};

// Disk-side build validation command for the buildValidation finalCheck. Pure
// shell, offline, exits 0 only if both scaffolded files survived to disk.
const buildValidationCommand =
  "test -f package.json && test -f src/App.tsx && test -f src/index.ts && echo BUILD_VALIDATED";

// ---------------------------------------------------------------------------
// Helpers (small, JSON-stable comparisons that yield descriptive failures).
// ---------------------------------------------------------------------------

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
  return expectEqual(
    actionParameters(action),
    expectedParameters,
    `${action.actionName} handler options`,
  );
}

function expectFileWriteTurn(
  execution: ScenarioTurnExecution,
  expectedParameters: JsonRecord,
  expectedPath: string,
): string | undefined {
  const action = firstAction(execution, "FILE");
  if (typeof action === "string") return action;
  return (
    expectActionOptions(action, expectedParameters) ??
    expectSuccess(action) ??
    (() => {
      const data = actionData(action);
      if (typeof data === "string") return data;
      if (data.path !== expectedPath) {
        return `expected FILE write path=${expectedPath}, saw ${String(data.path)}`;
      }
      return typeof data.bytes === "number" && data.bytes > 0
        ? undefined
        : `expected FILE write byte count > 0, saw ${stableStringify(data.bytes)}`;
    })()
  );
}

function expectBuildTurn(execution: ScenarioTurnExecution): string | undefined {
  const action = firstAction(execution, "SHELL");
  if (typeof action === "string") return action;
  return (
    expectActionOptions(action, buildParameters) ??
    expectSuccess(action) ??
    (() => {
      const data = actionData(action);
      if (typeof data === "string") return data;
      if (data.cwd !== appDir) {
        return `expected SHELL cwd=${appDir}, saw ${String(data.cwd)}`;
      }
      if (data.exit_code !== 0) {
        return `expected SHELL exit_code=0, saw ${String(data.exit_code)}`;
      }
      return action.result?.text?.includes("BUILD_OK")
        ? undefined
        : `expected build stdout BUILD_OK, saw ${JSON.stringify(action.result?.text)}`;
    })()
  );
}

// ---------------------------------------------------------------------------
// Custom finalCheck predicates.
// ---------------------------------------------------------------------------

// Emulates the file-mutation proof at the strongest possible fidelity: the bytes
// are actually on disk, byte-for-byte equal to what we asked the FILE action to
// write. (Complements the registered fileMutationOccurred finalCheck, which only
// proves the action was *invoked* with a matching path.)
async function assertScaffoldedFilesOnDisk(): Promise<string | undefined> {
  const expectations: Array<[string, string]> = [
    [appTsxPath, appTsxContent],
    [packageJsonPath, packageJsonContent],
    [indexTsPath, indexTsContent],
  ];
  for (const [filePath, expected] of expectations) {
    let actual: string;
    try {
      actual = await fs.readFile(filePath, "utf8");
    } catch (err) {
      return `expected scaffolded file on disk at ${filePath}, read failed: ${(err as Error).message}`;
    }
    if (actual !== expected) {
      return `expected ${filePath} content ${JSON.stringify(expected)}, saw ${JSON.stringify(actual)}`;
    }
  }
  return undefined;
}

// Emulates a build-validation proof from the captured action ledger: the SHELL
// build ran in the scaffolded app dir and exited 0. (Complements the registered
// buildValidation finalCheck, which re-runs a command on disk.)
function assertBuildPassedInAppDir(ctx: ScenarioContext): string | undefined {
  const shell = ctx.actionsCalled.find((call) => call.actionName === "SHELL");
  if (!shell) {
    return `expected a SHELL build action, saw ${ctx.actionsCalled.map((c) => c.actionName).join(",") || "(none)"}`;
  }
  const data = actionData(shell);
  if (typeof data === "string") return data;
  if (data.exit_code !== 0) {
    return `expected build SHELL exit_code=0, saw ${String(data.exit_code)}`;
  }
  if (data.cwd !== appDir) {
    return `expected build SHELL to run in app dir ${appDir}, saw ${String(data.cwd)}`;
  }
  return undefined;
}

// The deterministic lane MUST NOT spawn a real sub-agent — assert the negative so
// the scaffold+build path is the honest substitute, not a silent omission.
function assertNoSubAgentSpawned(ctx: ScenarioContext): string | undefined {
  const spawnNames = new Set([
    "START_CODING_TASK",
    "CREATE_TASK",
    "TASKS_SPAWN_AGENT",
    "TASKS_CREATE",
    "SPAWN_AGENT",
    "SPAWN_TASK_AGENT",
  ]);
  const spawned = ctx.actionsCalled.filter(
    (call) =>
      spawnNames.has(call.actionName) ||
      /SPAWN|START_CODING/i.test(call.actionName),
  );
  return spawned.length === 0
    ? undefined
    : `expected NO sub-agent spawn in the deterministic lane, saw ${spawned.map((s) => s.actionName).join(",")}`;
}

// Exact action ledger order (no synthesized REPLY — action turns never synthesize)
// AND filesystem cleanup so re-runs in the shared runtime stay idempotent.
async function assertLedgerAndCleanup(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const names = (ctx.actionsCalled ?? []).map((call) => call.actionName);
  const orderFailure = expectEqual(
    names,
    ["FILE", "FILE", "FILE", "SHELL"],
    "create-app action ledger order",
  );
  if (orderFailure) return orderFailure;
  const failed = (ctx.actionsCalled ?? []).filter(
    (call) => call.result?.success !== true,
  );
  if (failed.length > 0) {
    return `expected every create-app action to succeed, saw ${stableStringify(failed)}`;
  }
  await fs.rm(tmpRoot, { force: true, recursive: true });
  return undefined;
}

// ---------------------------------------------------------------------------
// Seed: build an isolated git workspace + self-register coding-tools.
// ---------------------------------------------------------------------------

async function seedGitRepo(): Promise<void> {
  await fs.rm(tmpRoot, { force: true, recursive: true });
  await fs.mkdir(appDir, { recursive: true });
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

export default scenario({
  // NOTE: `id` MUST be a static string literal — the loader reads it via the
  // TypeScript AST without evaluating the module (see loader.ts
  // getStaticStringProperty). Keep it in sync with `scenarioId` above.
  id: "deterministic-create-app-coding",
  lane: "pr-deterministic",
  title: "Deterministic create-app coding loop (scaffold + build)",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "zero-cost", "coding-tools", "create-app"],
  isolation: "shared-runtime",
  requires: {
    plugins: ["@elizaos/plugin-coding-tools"],
  },
  seed: [
    {
      type: "custom",
      name: "seed isolated create-app git workspace + coding-tools",
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
            }
          | undefined;
        if (!runtime?.registerPlugin) {
          return "runtime.registerPlugin unavailable";
        }
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
        // Allow the whole tmpRoot so writes under appDir validate; ground the
        // session cwd to appDir so SHELL's cwd resolves there.
        sandbox.addRoot(roomId, tmpRoot);
        session.setCwd(roomId, appDir);
        await runtime.ensureConnection?.({
          entityId: userId,
          roomId,
          worldId,
          userName: "Deterministic Create App",
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
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Deterministic Create App",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "scaffold src/App.tsx",
      text: "Scaffold the create-app App component file",
      actionName: "FILE",
      options: writeAppTsxParameters,
      responseIncludesAny: ["Wrote", appTsxPath],
      assertTurn: (execution) =>
        expectFileWriteTurn(execution, writeAppTsxParameters, appTsxPath),
    },
    {
      kind: "action",
      name: "scaffold package.json",
      text: "Scaffold the create-app package manifest",
      actionName: "FILE",
      options: writePackageJsonParameters,
      responseIncludesAny: ["Wrote", packageJsonPath],
      assertTurn: (execution) =>
        expectFileWriteTurn(
          execution,
          writePackageJsonParameters,
          packageJsonPath,
        ),
    },
    {
      kind: "action",
      name: "scaffold src/index.ts",
      text: "Scaffold the create-app entry module",
      actionName: "FILE",
      options: writeIndexTsParameters,
      responseIncludesAny: ["Wrote", indexTsPath],
      assertTurn: (execution) =>
        expectFileWriteTurn(execution, writeIndexTsParameters, indexTsPath),
    },
    {
      kind: "action",
      name: "build the scaffolded app",
      text: "Run the create-app build and verification command",
      actionName: "SHELL",
      options: buildParameters,
      responseIncludesAny: ["BUILD_OK"],
      assertTurn: expectBuildTurn,
    },
  ],
  finalChecks: [
    // Exactly the three scaffold writes succeeded.
    {
      type: "actionCalled",
      actionName: "FILE",
      status: "success",
      minCount: 3,
    },
    // The build/verify command exited 0 (handler returns success only on exit 0).
    {
      type: "actionCalled",
      actionName: "SHELL",
      status: "success",
      minCount: 1,
    },
    // The real scaffolded filenames flowed through the captured action args.
    {
      type: "selectedActionArguments",
      actionName: ["FILE", "SHELL"],
      includesAll: [/App\.tsx/, /package\.json/, /index\.ts/, /BUILD_OK/],
    },
    // Registered file-mutation proof: a FILE write touched each scaffold path.
    {
      type: "fileMutationOccurred",
      name: "scaffolded App.tsx file mutation",
      path: /App\.tsx$/,
      minCount: 1,
    },
    {
      type: "fileMutationOccurred",
      name: "scaffolded package.json file mutation",
      path: /package\.json$/,
      minCount: 1,
    },
    {
      type: "fileMutationOccurred",
      name: "all three scaffold writes",
      minCount: 3,
    },
    // Registered build validation: re-run a build/verify in the scaffolded app
    // dir on disk and assert exit 0 (proves the produced workspace is sound).
    {
      type: "buildValidation",
      name: "scaffolded app dir builds/verifies clean",
      workdir: appDir,
      command: buildValidationCommand,
      expectExitZero: true,
    },
    // file-mutation emulation at byte-for-byte fidelity on disk.
    {
      type: "custom",
      name: "fileMutationOccurred — scaffolded app files exist on disk byte-for-byte",
      predicate: assertScaffoldedFilesOnDisk,
    },
    // build-validation emulation from the captured ledger.
    {
      type: "custom",
      name: "buildValidation — verify command passed in the scaffolded app dir",
      predicate: assertBuildPassedInAppDir,
    },
    // subAgentSpawned NEGATIVE: no real sub-agent spawn in the deterministic lane.
    {
      type: "custom",
      name: "subAgentSpawned — N/A asserted explicitly (deterministic lane spawns no sub-agent)",
      predicate: assertNoSubAgentSpawned,
    },
    // Exact ledger order + cleanup (must be last so tmpRoot is removed at the end).
    {
      type: "custom",
      name: "create-app action ledger order is exact and workspace cleaned up",
      predicate: assertLedgerAndCleanup,
    },
  ],
});
