/**
 * Ratchets campaign benchmark routing onto Eliza's native runtime APIs.
 * The source-level guard covers every specialized classifier because a raw
 * provider fallback can otherwise evade unit tests for an unselected lane.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverSource = readFileSync(
  fileURLToPath(new URL("../server.ts", import.meta.url)),
  "utf8",
);
const packageJson = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../package.json", import.meta.url)),
    "utf8",
  ),
) as {
  scripts: { "benchmark:server": string };
  dependencies: Record<string, string>;
};
const messageRouteMarker =
  'if (pathname === "/api/benchmark/message" && req.method === "POST")';
const messageRouteStart = serverSource.indexOf(messageRouteMarker);
const messageRoute = serverSource.slice(messageRouteStart);

const specializedClassifiers = [
  "isWooBenchName",
  "isActionCallingBenchmarkName",
  "_isTauBenchmarkName",
  "isVendingBenchmarkName",
  "isLocaBenchmarkName",
  "isBfclBenchmarkName",
  "isWebShopBenchmarkName",
  "isHermesNativeEnvProxyName",
  "isTerminalBenchmarkName",
  "isSweBenchmarkName",
  "isVisualWebBenchmarkName",
  "isOsworldBenchmarkName",
] as const;

describe("campaign-native Eliza routing", () => {
  it("uses Node/tsx with the workspace tsconfig so source aliases stay executable", () => {
    expect(packageJson.scripts["benchmark:server"]).toBe(
      "TSX_TSCONFIG_PATH=../../tsconfig.json node --conditions=eliza-source --import tsx src/server.ts",
    );
  });

  it("contains no raw OpenAI-compatible transport helper", () => {
    expect(serverSource).not.toContain("callOpenAiCompatible");
    expect(serverSource).not.toMatch(/\bfetch\s*\(/);
  });

  it("cannot reload ancestor dotenv credentials in subscription mode", () => {
    expect(serverSource).toContain(
      'process.env.ELIZA_BENCH_DISABLE_DOTENV === "1"',
    );
    expect(serverSource).toContain(
      'process.env.ELIZA_BENCH_SUBSCRIPTION_CHAT_ONLY === "1"',
    );
    expect(serverSource).toContain("const _loadedEnvPath = dotenvDisabled");
    expect(serverSource).toContain(": loadEnvFromAncestors(process.cwd())");
  });

  it("loads and proves native TASKS when lifecycle requires orchestration", () => {
    expect(packageJson.dependencies["@elizaos/plugin-agent-orchestrator"]).toBe(
      "workspace:*",
    );
    expect(serverSource).toContain(
      'process.env.ELIZA_BENCH_REQUIRE_ORCHESTRATOR === "1"',
    );
    expect(serverSource).toContain("hasLifecycleTaskAction(runtime)");
    expect(serverSource).toContain(
      '"ELIZA_BENCH_REQUIRE_ORCHESTRATOR=1 but TASKS/TASKS_* was not registered"',
    );
    expect(serverSource).toContain(
      "lifecycle_task_action_registered: lifecycleTaskActionRegistered",
    );
    expect(serverSource).toContain("registeredActionCatalog.length !== 1");
    expect(serverSource).toContain('registeredActionCatalog[0] !== "TASKS"');
    expect(serverSource).toContain("lifecycle_tool_bridge: lifecycleProfile");
    expect(serverSource).toContain('"lifecycle_capture_only"');
    expect(serverSource).toContain("runWithLifecycleTaskCapture");
    expect(serverSource).toContain("runWithLlmInputSubstringAttestation");
    expect(serverSource).toContain("runWithBenchmarkContext");
    expect(serverSource).toContain(
      'code: "BENCHMARK_LIFECYCLE_SYSTEM_HINT_INVALID"',
    );
    expect(serverSource).toContain(
      "attestation.modelCallCount !== turnUsage.callCount",
    );
    expect(serverSource).toContain("lifecycleSystemHintAttestation:");
    expect(serverSource).toContain("projectLifecycleTaskExecutions");
    expect(serverSource).toContain(
      "lifecycleCaptureOnlyPlugin(resolvedPlugin)",
    );
    expect(serverSource).toContain("retainOnlyLifecycleTaskAction(runtime)");
    expect(serverSource).toContain(
      "enableDocuments: lifecycleProfile ? false : undefined",
    );
    expect(serverSource).toContain(
      "enableRelationships: lifecycleProfile ? false : undefined",
    );
    expect(serverSource).toContain(
      "enableTrajectories: lifecycleProfile ? false : undefined",
    );
    expect(serverSource).toContain(
      "lifecycleStructuredResponseTool: lifecycleProfile",
    );
    expect(serverSource).toContain(
      "lifecycleTasksToolSchema: lifecycleProfile",
    );
    expect(serverSource).toContain(
      "LIFECYCLE_TASKS_TOOL_CONTRACT.function.parameters",
    );
  });

  it.each(
    specializedClassifiers,
  )("%s reaches AgentRuntime.useModel with explicit provenance", (classifier) => {
    const classifierStart = messageRoute.indexOf(
      `${classifier}(session.benchmark)`,
    );
    expect(classifierStart).toBeGreaterThanOrEqual(0);
    const metadataStart = messageRoute.indexOf(
      "const metadata = benchmarkTurnMetadata",
      classifierStart,
    );
    expect(metadataStart).toBeGreaterThan(classifierStart);
    const branch = messageRoute.slice(classifierStart, metadataStart + 500);

    expect(branch).toContain("runtime.useModel");
    expect(branch).toContain('nativeRuntimeApi: "useModel"');
    expect(branch).toMatch(/toolBridge: "runtime_model_(?:native_tools|text)"/);
    expect(branch).not.toMatch(/\bfetch\s*\(/);
  });

  it("keeps the generic conversation path on messageService.handleMessage", () => {
    const genericStart = messageRoute.indexOf(
      "const incomingMessage: Memory =",
    );
    const genericPath = messageRoute.slice(genericStart);

    expect(genericPath).toContain("messageService.handleMessage(");
    expect(genericPath).toContain(
      'nativeRuntimeApi: "messageService.handleMessage"',
    );
    expect(genericPath).toMatch(
      /toolBridge:\s*lifecycleProfile\s*\?\s*"lifecycle_capture_only"\s*:\s*"native_action_capture"/,
    );
  });
});
