/**
 * #15310 failure #4: a RETURNING user whose existing Eliza Cloud agent is
 * DEDICATED (its own `<id>.elizacloud.ai` subdomain) is bound to that subdomain
 * base, but the dedicated agent ingress does not expose every local-agent probe
 * endpoint (`/api/status`, `/api/config`) to browser clients. Before the fix,
 * those probes produced noisy 401/404 console entries even though dedicated REST
 * chat was live.
 *
 * `getStatus()` must instead treat a dedicated cloud base like the shared REST
 * adapter: RUNNING without probing `/api/status`. Startup still uses
 * `/api/conversations` as the authoritative warm-passthrough gate before chat.
 *
 * Transport stubbed, no live agent, no desktop RPC (plain HTTP status path).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBootConfig } from "../config/boot-config";
import { chunkPtyInput, MAX_PTY_INPUT_CHUNK_LENGTH } from "./client-agent";
import { ElizaClient } from "./client-base";
import type { AgentRequestTransport } from "./transport";

function makeClient(
  baseUrl: string,
  handler: AgentRequestTransport["request"],
  token = "token",
): ElizaClient {
  const client = new ElizaClient(baseUrl, token);
  client.setRequestTransport({ request: vi.fn(handler) });
  return client;
}

const DEDICATED_BASE = "https://agent-abc123.elizacloud.ai";
const LOCAL_BASE = "http://127.0.0.1:31337";

type RoutingClient = Record<string, (...args: unknown[]) => unknown>;

interface RouteCall {
  path: string;
  method: string;
  body?: BodyInit | null;
}

function sharedResolver404(): Response {
  return new Response(JSON.stringify({ error: "Not a shared-runtime agent" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

function routePayload(): Record<string, unknown> {
  const status = {
    state: "running",
    agentName: "Eliza",
    canRespond: true,
  };
  return {
    ok: true,
    success: true,
    required: false,
    pairingEnabled: false,
    authenticated: true,
    expiresAt: 123,
    identityId: "identity-1",
    token: "paired-token",
    sessionId: "session-1",
    status,
    cloud: {},
    provider: "openai",
    restarting: false,
    connectors: [],
    accounts: [],
    account: { id: "account-1", status: "connected", role: "OWNER" },
    defaultAccountId: null,
    flow: { authUrl: "https://auth.example", status: "pending" },
    authUrl: "https://auth.example",
    data: [],
    stats: {},
    total: 0,
    models: [],
    entries: [],
    loaded_at: null,
    updated: ["OPENAI_API_KEY"],
    childSessionId: "child-1",
    credentialScopeId: "scope-1",
    key: "OPENAI_API_KEY",
    deleted: true,
    tasks: [],
    projects: [],
    activeProjectId: null,
    taskCount: 0,
    paused: 1,
    resumed: 1,
    stopped: true,
    output: "buffered-output",
    session: { sessionId: "pty-1" },
    enabled: true,
    recorded: true,
    failedTo: [],
    scratch: { sessionId: "scratch-1", path: "/tmp/scratch" },
    graph: {},
    result: {},
    experience: {},
    accepted: true,
    cancelled: true,
    providerId: "openai",
    strategy: "inline" as const,
  };
}

function makeRoutingClient(): { client: RoutingClient; calls: RouteCall[] } {
  const calls: RouteCall[] = [];
  const request = vi.fn<AgentRequestTransport["request"]>(async (url, init) => {
    const parsed = new URL(url);
    calls.push({
      path: `${parsed.pathname}${parsed.search}`,
      method: init.method ?? "GET",
      body: init.body,
    });
    return new Response(JSON.stringify(routePayload()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const client = new ElizaClient(LOCAL_BASE, "token");
  client.setRequestTransport({ request });
  return { client: client as unknown as RoutingClient, calls };
}

async function runRouteSmoke(
  client: RoutingClient,
  label: string,
  invoke: (client: RoutingClient) => unknown,
): Promise<void> {
  try {
    await invoke(client);
  } catch (error) {
    throw new Error(`route smoke failed for ${label}`, { cause: error });
  }
}

describe("ElizaClient.getStatus — dedicated agent shared-resolver 404 (#15310 #4)", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
    vi.restoreAllMocks();
    // No desktop electrobun RPC / native lifecycle — force the plain HTTP path.
    Reflect.deleteProperty(globalThis, "window");
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
  });

  it("short-circuits authenticated dedicated status as RUNNING without probing /api/status", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () => {
      throw new Error("/api/status should not be probed for dedicated cloud");
    });
    const client = makeClient(DEDICATED_BASE, request);

    const status = await client.getStatus();

    expect(status.state).toBe("running");
    expect(status.canRespond).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("short-circuits dedicated status even before token hydration", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () => {
      throw new Error("/api/status should not be probed for dedicated cloud");
    });
    const client = makeClient(DEDICATED_BASE, request, "");

    const status = await client.getStatus();

    expect(status.state).toBe("running");
    expect(status.canRespond).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("does NOT treat the shared-resolver 404 as running for a NON-dedicated base", async () => {
    // A loopback / self-hosted agent base that happens to 404 with the same
    // body is not a dedicated cloud agent — the running short-circuit must be
    // scoped to dedicated cloud bases only, so this still throws.
    const client = makeClient("http://127.0.0.1:31337", async (url) => {
      const path = new URL(url).pathname;
      if (path === "/api/status") return sharedResolver404();
      return new Response("{}", { status: 200 });
    });

    await expect(client.getStatus()).rejects.toThrow();
  });

  it("omits dedicated-CORS-blocked automatic headers while keeping Authorization", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = makeClient(DEDICATED_BASE, request);
    client.setUiLanguage("en");

    await client.fetch("/api/status", {
      headers: {
        "X-ElizaOS-Client-Id": "manual-client-id",
        "X-ElizaOS-UI-Language": "es",
      },
    });

    const headers = request.mock.calls[0]?.[1].headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer token");
    const lowerHeaderNames = Object.keys(headers).map((key) =>
      key.toLowerCase(),
    );
    expect(lowerHeaderNames).not.toContain("x-elizaos-client-id");
    expect(lowerHeaderNames).not.toContain("x-elizaos-ui-language");
  });

  it("short-circuits authenticated dedicated config as empty without probing /api/config", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () => {
      throw new Error("/api/config should not be probed for dedicated cloud");
    });
    const client = makeClient(DEDICATED_BASE, request);

    await expect(client.getConfig()).resolves.toEqual({});
    expect(request).not.toHaveBeenCalled();
  });

  it("covers fetch-backed client-agent route wrappers used around cloud startup", async () => {
    const { client, calls } = makeRoutingClient();
    const cases: Array<{
      label: string;
      invoke: (client: RoutingClient) => unknown;
    }> = [
      { label: "getWalletKeys", invoke: (c) => c.getWalletKeys() },
      {
        label: "getWalletOsStoreStatus",
        invoke: (c) => c.getWalletOsStoreStatus(),
      },
      {
        label: "postWalletOsStoreAction",
        invoke: (c) => c.postWalletOsStoreAction("enable"),
      },
      { label: "getAuthStatus", invoke: (c) => c.getAuthStatus() },
      {
        label: "postBootstrapExchange",
        invoke: (c) => c.postBootstrapExchange("bootstrap-token"),
      },
      { label: "pair", invoke: (c) => c.pair("123456") },
      {
        label: "getFirstRunStatus",
        invoke: (c) => c.getFirstRunStatus(),
      },
      {
        label: "getFirstRunOptions",
        invoke: (c) => c.getFirstRunOptions(),
      },
      { label: "submitFirstRun", invoke: (c) => c.submitFirstRun({}) },
      {
        label: "startAnthropicLogin",
        invoke: (c) => c.startAnthropicLogin(),
      },
      {
        label: "exchangeAnthropicCode",
        invoke: (c) => c.exchangeAnthropicCode("code"),
      },
      {
        label: "submitAnthropicSetupToken",
        invoke: (c) => c.submitAnthropicSetupToken("token"),
      },
      {
        label: "getSubscriptionStatus",
        invoke: (c) => c.getSubscriptionStatus(),
      },
      {
        label: "deleteSubscription",
        invoke: (c) => c.deleteSubscription("anthropic"),
      },
      {
        label: "switchProvider",
        invoke: (c) => c.switchProvider("openai", "key", "gpt-4o-mini"),
      },
      { label: "startOpenAILogin", invoke: (c) => c.startOpenAILogin() },
      {
        label: "exchangeOpenAICode",
        invoke: (c) => c.exchangeOpenAICode("code"),
      },
      { label: "startAgent", invoke: (c) => c.startAgent() },
      { label: "stopAgent", invoke: (c) => c.stopAgent() },
      { label: "pauseAgent", invoke: (c) => c.pauseAgent() },
      { label: "resumeAgent", invoke: (c) => c.resumeAgent() },
      { label: "restartAgent", invoke: (c) => c.restartAgent() },
      { label: "resetAgent", invoke: (c) => c.resetAgent() },
      { label: "restart", invoke: (c) => c.restart() },
      { label: "getConfig", invoke: (c) => c.getConfig() },
      { label: "getConfigSchema", invoke: (c) => c.getConfigSchema() },
      { label: "updateConfig", invoke: (c) => c.updateConfig({ cloud: {} }) },
      { label: "getConnectors", invoke: (c) => c.getConnectors() },
      {
        label: "saveConnector",
        invoke: (c) => c.saveConnector("discord", { enabled: true }),
      },
      {
        label: "deleteConnector",
        invoke: (c) => c.deleteConnector("discord"),
      },
      {
        label: "listConnectorAccounts",
        invoke: (c) => c.listConnectorAccounts("discord"),
      },
      {
        label: "addConnectorAccount",
        invoke: (c) => c.addConnectorAccount("discord", "discord", {}),
      },
      {
        label: "startConnectorAccountOAuth",
        invoke: (c) => c.startConnectorAccountOAuth("discord"),
      },
      {
        label: "patchConnectorAccount",
        invoke: (c) =>
          c.patchConnectorAccount("discord", "discord", "account-1", {
            enabled: true,
          }),
      },
      {
        label: "testConnectorAccount",
        invoke: (c) =>
          c.testConnectorAccount("discord", "discord", "account-1"),
      },
      {
        label: "refreshConnectorAccount",
        invoke: (c) =>
          c.refreshConnectorAccount("discord", "discord", "account-1"),
      },
      {
        label: "deleteConnectorAccount",
        invoke: (c) =>
          c.deleteConnectorAccount("discord", "discord", "account-1"),
      },
      {
        label: "makeDefaultConnectorAccount",
        invoke: (c) =>
          c.makeDefaultConnectorAccount("discord", "discord", "account-1"),
      },
      {
        label: "listConnectorAccountAuditEvents",
        invoke: (c) =>
          c.listConnectorAccountAuditEvents("discord", {
            accountId: "account-1",
            action: "refresh",
            outcome: "ok",
            limit: 5,
          }),
      },
      { label: "getTriggers", invoke: (c) => c.getTriggers() },
      { label: "getTrigger", invoke: (c) => c.getTrigger("trigger-1") },
      {
        label: "createTrigger",
        invoke: (c) => c.createTrigger({ name: "daily" }),
      },
      {
        label: "updateTrigger",
        invoke: (c) => c.updateTrigger("trigger-1", { name: "daily" }),
      },
      {
        label: "deleteTrigger",
        invoke: (c) => c.deleteTrigger("trigger-1"),
      },
      {
        label: "runTriggerNow",
        invoke: (c) => c.runTriggerNow("trigger-1"),
      },
      {
        label: "getTriggerRuns",
        invoke: (c) => c.getTriggerRuns("trigger-1"),
      },
      {
        label: "emitTriggerEvent",
        invoke: (c) => c.emitTriggerEvent("calendar.event", { id: 1 }),
      },
      { label: "getTriggerHealth", invoke: (c) => c.getTriggerHealth() },
      { label: "getTrainingStatus", invoke: (c) => c.getTrainingStatus() },
      {
        label: "listTrainingTrajectories",
        invoke: (c) => c.listTrainingTrajectories({ limit: 2, offset: 1 }),
      },
      {
        label: "getTrainingTrajectory",
        invoke: (c) => c.getTrainingTrajectory("trajectory-1"),
      },
      {
        label: "listTrainingDatasets",
        invoke: (c) => c.listTrainingDatasets(),
      },
      {
        label: "buildTrainingDataset",
        invoke: (c) => c.buildTrainingDataset({ source: "local" }),
      },
      {
        label: "writeTrainingBenchmarkMatrix",
        invoke: (c) => c.writeTrainingBenchmarkMatrix({}),
      },
      { label: "listTrainingJobs", invoke: (c) => c.listTrainingJobs() },
      {
        label: "startTrainingJob",
        invoke: (c) => c.startTrainingJob({ model: "small" }),
      },
      {
        label: "getTrainingJob",
        invoke: (c) => c.getTrainingJob("job-1"),
      },
      {
        label: "cancelTrainingJob",
        invoke: (c) => c.cancelTrainingJob("job-1"),
      },
      {
        label: "listTrainingModels",
        invoke: (c) => c.listTrainingModels(),
      },
      {
        label: "importTrainingModelToOllama",
        invoke: (c) => c.importTrainingModelToOllama("model-1", {}),
      },
      {
        label: "activateTrainingModel",
        invoke: (c) => c.activateTrainingModel("model-1", "provider-model"),
      },
      {
        label: "benchmarkTrainingModel",
        invoke: (c) => c.benchmarkTrainingModel("model-1"),
      },
      {
        label: "buildTrainingAnalysisIndex",
        invoke: (c) => c.buildTrainingAnalysisIndex({}),
      },
      {
        label: "buildTrainingReadinessReport",
        invoke: (c) => c.buildTrainingReadinessReport({}),
      },
      {
        label: "ingestHuggingFaceTrainingDataset",
        invoke: (c) => c.ingestHuggingFaceTrainingDataset({}),
      },
      {
        label: "stageEliza1Bundle",
        invoke: (c) => c.stageEliza1Bundle({}),
      },
      {
        label: "runFeedTrainingGeneration",
        invoke: (c) => c.runFeedTrainingGeneration({}),
      },
      {
        label: "runTrainingScenarios",
        invoke: (c) => c.runTrainingScenarios({}),
      },
      {
        label: "runTrainingActionBenchmark",
        invoke: (c) => c.runTrainingActionBenchmark({}),
      },
      {
        label: "runTrainingBenchmarkVsCerebras",
        invoke: (c) => c.runTrainingBenchmarkVsCerebras({}),
      },
      {
        label: "runTrainingLocalEvalComparison",
        invoke: (c) => c.runTrainingLocalEvalComparison({}),
      },
      {
        label: "runTrainingCollection",
        invoke: (c) => c.runTrainingCollection({}),
      },
      {
        label: "listTrainingCollections",
        invoke: (c) => c.listTrainingCollections({ limit: 3, root: "root" }),
      },
      { label: "getPlugins", invoke: (c) => c.getPlugins() },
      { label: "fetchModels", invoke: (c) => c.fetchModels("openai", true) },
      { label: "getCorePlugins", invoke: (c) => c.getCorePlugins() },
      {
        label: "toggleCorePlugin",
        invoke: (c) => c.toggleCorePlugin("@elizaos/plugin", true),
      },
      {
        label: "updatePlugin",
        invoke: (c) => c.updatePlugin("@elizaos/plugin", { enabled: true }),
      },
      { label: "getSecrets", invoke: (c) => c.getSecrets() },
      {
        label: "updateSecrets",
        invoke: (c) => c.updateSecrets({ OPENAI_API_KEY: "value" }),
      },
      {
        label: "tunnelCredential",
        invoke: (c) =>
          c.tunnelCredential({
            credentialScopeId: "scope-1",
            childSessionId: "child-1",
            key: "OPENAI_API_KEY",
            value: "secret",
          }),
      },
      {
        label: "testPluginConnection",
        invoke: (c) => c.testPluginConnection("@elizaos/plugin"),
      },
      {
        label: "getLogs",
        invoke: (c) =>
          c.getLogs({ source: "agent", level: "info", tag: "boot", since: 1 }),
      },
      {
        label: "getSecurityAudit",
        invoke: (c) =>
          c.getSecurityAudit({
            type: "secrets",
            severity: "high",
            since: new Date("2026-01-01T00:00:00Z"),
            limit: 10,
          }),
      },
      {
        label: "getAgentEvents",
        invoke: (c) =>
          c.getAgentEvents({
            afterEventId: "event-1",
            limit: 5,
            runId: "run-1",
            fromSeq: 2.7,
          }),
      },
      { label: "getExtensionStatus", invoke: (c) => c.getExtensionStatus() },
      {
        label: "getRelationshipsGraph",
        invoke: (c) =>
          c.getRelationshipsGraph({
            search: "nubs",
            platform: "x",
            scope: "all",
            limit: 5,
            offset: 1,
          }),
      },
      {
        label: "getRelationshipsPeople",
        invoke: (c) =>
          c.getRelationshipsPeople({
            search: "nubs",
            platform: "x",
            scope: "all",
            limit: 5,
            offset: 1,
          }),
      },
      {
        label: "getRelationshipsPerson",
        invoke: (c) => c.getRelationshipsPerson("person-1"),
      },
      {
        label: "getRelationshipsActivity",
        invoke: (c) => c.getRelationshipsActivity(10, 2),
      },
      {
        label: "getRelationshipsCandidates",
        invoke: (c) => c.getRelationshipsCandidates(),
      },
      {
        label: "acceptRelationshipsCandidate",
        invoke: (c) => c.acceptRelationshipsCandidate("candidate-1"),
      },
      {
        label: "rejectRelationshipsCandidate",
        invoke: (c) => c.rejectRelationshipsCandidate("candidate-1"),
      },
      {
        label: "proposeRelationshipsLink",
        invoke: (c) =>
          c.proposeRelationshipsLink("source-1", "target-1", {
            reason: "test",
          }),
      },
      { label: "getCharacter", invoke: (c) => c.getCharacter() },
      { label: "getRandomName", invoke: (c) => c.getRandomName() },
      {
        label: "generateCharacterField",
        invoke: (c) => c.generateCharacterField("bio", "context", "append"),
      },
      {
        label: "updateCharacter",
        invoke: (c) => c.updateCharacter({ name: "Eliza" }),
      },
      {
        label: "listCharacterHistory",
        invoke: (c) => c.listCharacterHistory({ limit: 10, offset: 5 }),
      },
      {
        label: "listExperiences",
        invoke: (c) =>
          c.listExperiences({
            limit: 10,
            offset: 2,
            q: "query",
            query: "semantic",
            minConfidence: 0.4,
            minImportance: 0.5,
            includeRelated: true,
            type: ["fact", "event"],
            outcome: "success",
            domain: ["chat", "cloud"],
            tags: [" one ", "", "two"],
          }),
      },
      {
        label: "getExperienceGraph",
        invoke: (c) =>
          c.getExperienceGraph({
            limit: 10,
            q: "query",
            type: "fact",
            includeRelated: false,
          }),
      },
      {
        label: "runExperienceMaintenance",
        invoke: (c) => c.runExperienceMaintenance({ dryRun: true }),
      },
      { label: "getExperience", invoke: (c) => c.getExperience("exp-1") },
      {
        label: "updateExperience",
        invoke: (c) => c.updateExperience("exp-1", { importance: 1 }),
      },
      {
        label: "deleteExperience",
        invoke: (c) => c.deleteExperience("exp-1"),
      },
      {
        label: "getUpdateStatus",
        invoke: (c) => c.getUpdateStatus(true),
      },
      {
        label: "setUpdateChannel",
        invoke: (c) => c.setUpdateChannel("stable"),
      },
      {
        label: "getAgentAutomationMode",
        invoke: (c) => c.getAgentAutomationMode(),
      },
      {
        label: "setAgentAutomationMode",
        invoke: (c) => c.setAgentAutomationMode("manual"),
      },
      {
        label: "getTradePermissionMode",
        invoke: (c) => c.getTradePermissionMode(),
      },
      {
        label: "setTradePermissionMode",
        invoke: (c) => c.setTradePermissionMode("disabled"),
      },
      { label: "getPermissions", invoke: (c) => c.getPermissions() },
      {
        label: "getPermission",
        invoke: (c) => c.getPermission("filesystem"),
      },
      {
        label: "requestPermission",
        invoke: (c) => c.requestPermission("filesystem"),
      },
      {
        label: "openPermissionSettings",
        invoke: (c) => c.openPermissionSettings("filesystem"),
      },
      {
        label: "refreshPermissions",
        invoke: (c) => c.refreshPermissions(),
      },
      {
        label: "setShellEnabled",
        invoke: (c) => c.setShellEnabled(true),
      },
      { label: "isShellEnabled", invoke: (c) => c.isShellEnabled() },
      {
        label: "getWebsiteBlockerStatus",
        invoke: (c) => c.getWebsiteBlockerStatus(),
      },
      {
        label: "startWebsiteBlock",
        invoke: (c) => c.startWebsiteBlock({ durationMs: 1000 }),
      },
      {
        label: "stopWebsiteBlock",
        invoke: (c) => c.stopWebsiteBlock(),
      },
      {
        label: "getAppBlockerStatus",
        invoke: (c) => c.getAppBlockerStatus(),
      },
      {
        label: "checkAppBlockerPermissions",
        invoke: (c) => c.checkAppBlockerPermissions(),
      },
      {
        label: "requestAppBlockerPermissions",
        invoke: (c) => c.requestAppBlockerPermissions(),
      },
      {
        label: "getInstalledAppsToBlock",
        invoke: (c) => c.getInstalledAppsToBlock(),
      },
      {
        label: "selectAppBlockerApps",
        invoke: (c) => c.selectAppBlockerApps(),
      },
      {
        label: "startAppBlock",
        invoke: (c) => c.startAppBlock({ durationMs: 1000, apps: [] }),
      },
      { label: "stopAppBlock", invoke: (c) => c.stopAppBlock() },
      {
        label: "getCodingAgentStatus",
        invoke: (c) => c.getCodingAgentStatus(),
      },
      {
        label: "listCodingAgentTaskThreads",
        invoke: (c) =>
          c.listCodingAgentTaskThreads({
            includeArchived: true,
            status: "running",
            search: "fix",
            projectId: "project-1",
            limit: 20,
          }),
      },
      {
        label: "getCodingAgentTaskThread",
        invoke: (c) => c.getCodingAgentTaskThread("task-1"),
      },
      {
        label: "archiveCodingAgentTaskThread",
        invoke: (c) => c.archiveCodingAgentTaskThread("task-1"),
      },
      {
        label: "reopenCodingAgentTaskThread",
        invoke: (c) => c.reopenCodingAgentTaskThread("task-1"),
      },
      { label: "listProjects", invoke: (c) => c.listProjects() },
      {
        label: "activateProject",
        invoke: (c) => c.activateProject("project-1"),
      },
      {
        label: "getOrchestratorStatus",
        invoke: (c) => c.getOrchestratorStatus(),
      },
      {
        label: "getOrchestratorAccounts",
        invoke: (c) => c.getOrchestratorAccounts(),
      },
      {
        label: "getOrchestratorAccountReadiness",
        invoke: (c) => c.getOrchestratorAccountReadiness({ rotation: true }),
      },
      {
        label: "getOrchestratorRooms",
        invoke: (c) => c.getOrchestratorRooms(),
      },
      {
        label: "createOrchestratorTask",
        invoke: (c) => c.createOrchestratorTask({ title: "task" }),
      },
      {
        label: "pauseOrchestratorTask",
        invoke: (c) => c.pauseOrchestratorTask("task-1"),
      },
      {
        label: "resumeOrchestratorTask",
        invoke: (c) => c.resumeOrchestratorTask("task-1"),
      },
      {
        label: "deleteOrchestratorTask",
        invoke: (c) => c.deleteOrchestratorTask("task-1"),
      },
      {
        label: "forkOrchestratorTask",
        invoke: (c) => c.forkOrchestratorTask("task-1", {}),
      },
      {
        label: "updateOrchestratorTask",
        invoke: (c) => c.updateOrchestratorTask("task-1", { title: "task" }),
      },
      {
        label: "validateOrchestratorTask",
        invoke: (c) => c.validateOrchestratorTask("task-1", {}),
      },
      {
        label: "addOrchestratorAgent",
        invoke: (c) => c.addOrchestratorAgent("task-1", { name: "worker" }),
      },
      {
        label: "stopOrchestratorAgent",
        invoke: (c) => c.stopOrchestratorAgent("task-1", "session-1"),
      },
      {
        label: "retryOrchestratorTaskTurn",
        invoke: (c) => c.retryOrchestratorTaskTurn("task-1", {}),
      },
      {
        label: "rerunOrchestratorTaskFromEvent",
        invoke: (c) => c.rerunOrchestratorTaskFromEvent("task-1", {}),
      },
      {
        label: "restartOrchestratorTask",
        invoke: (c) => c.restartOrchestratorTask("task-1", {}),
      },
      {
        label: "restartOrchestratorTaskWithEditedPlan",
        invoke: (c) => c.restartOrchestratorTaskWithEditedPlan("task-1", {}),
      },
      {
        label: "listOrchestratorTaskPlanRevisions",
        invoke: (c) =>
          c.listOrchestratorTaskPlanRevisions("task-1", {
            cursor: "cursor",
            limit: 10,
          }),
      },
      {
        label: "createOrchestratorTaskPlanRevision",
        invoke: (c) =>
          c.createOrchestratorTaskPlanRevision("task-1", { plan: [] }),
      },
      {
        label: "listOrchestratorTaskMessages",
        invoke: (c) =>
          c.listOrchestratorTaskMessages("task-1", {
            cursor: "cursor",
            limit: 10,
          }),
      },
      {
        label: "postOrchestratorTaskMessage",
        invoke: (c) => c.postOrchestratorTaskMessage("task-1", "hello"),
      },
      {
        label: "listOrchestratorTaskEvents",
        invoke: (c) =>
          c.listOrchestratorTaskEvents("task-1", {
            cursor: "cursor",
            limit: 10,
          }),
      },
      {
        label: "listOrchestratorTaskTimeline",
        invoke: (c) =>
          c.listOrchestratorTaskTimeline("task-1", {
            cursor: "cursor",
            limit: 10,
          }),
      },
      {
        label: "pauseAllOrchestratorTasks",
        invoke: (c) => c.pauseAllOrchestratorTasks(),
      },
      {
        label: "resumeAllOrchestratorTasks",
        invoke: (c) => c.resumeAllOrchestratorTasks(),
      },
      {
        label: "stopCodingAgent",
        invoke: (c) => c.stopCodingAgent("session-1"),
      },
      {
        label: "listCodingAgentScratchWorkspaces",
        invoke: (c) => c.listCodingAgentScratchWorkspaces(),
      },
      {
        label: "keepCodingAgentScratchWorkspace",
        invoke: (c) => c.keepCodingAgentScratchWorkspace("session-1"),
      },
      {
        label: "deleteCodingAgentScratchWorkspace",
        invoke: (c) => c.deleteCodingAgentScratchWorkspace("session-1"),
      },
      {
        label: "promoteCodingAgentScratchWorkspace",
        invoke: (c) =>
          c.promoteCodingAgentScratchWorkspace("session-1", "workspace"),
      },
      {
        label: "spawnShellSession",
        invoke: (c) => c.spawnShellSession("/tmp"),
      },
      {
        label: "spawnPtySession",
        invoke: (c) => c.spawnPtySession({ cwd: "/tmp" }),
      },
      {
        label: "stopPtySession",
        invoke: (c) => c.stopPtySession("pty-1"),
      },
      {
        label: "getPtyBufferedOutput",
        invoke: (c) => c.getPtyBufferedOutput("pty-1"),
      },
      { label: "streamGoLive", invoke: (c) => c.streamGoLive() },
      { label: "streamGoOffline", invoke: (c) => c.streamGoOffline() },
      { label: "streamStatus", invoke: (c) => c.streamStatus() },
      {
        label: "getStreamingDestinations",
        invoke: (c) => c.getStreamingDestinations(),
      },
      {
        label: "setActiveDestination",
        invoke: (c) => c.setActiveDestination("destination-1"),
      },
      {
        label: "setStreamVolume",
        invoke: (c) => c.setStreamVolume(0.5),
      },
      { label: "muteStream", invoke: (c) => c.muteStream() },
      { label: "unmuteStream", invoke: (c) => c.unmuteStream() },
      { label: "getStreamVoice", invoke: (c) => c.getStreamVoice() },
      {
        label: "saveStreamVoice",
        invoke: (c) => c.saveStreamVoice({ voiceId: "voice-1" }),
      },
      {
        label: "streamVoiceSpeak",
        invoke: (c) => c.streamVoiceSpeak("hello"),
      },
      {
        label: "getOverlayLayout",
        invoke: (c) => c.getOverlayLayout("destination-1"),
      },
      {
        label: "saveOverlayLayout",
        invoke: (c) => c.saveOverlayLayout({ slots: [] }, "destination-1"),
      },
      { label: "getStreamSource", invoke: (c) => c.getStreamSource() },
      {
        label: "setStreamSource",
        invoke: (c) => c.setStreamSource("custom", "https://example.com"),
      },
      {
        label: "getStreamSettings",
        invoke: (c) => c.getStreamSettings(),
      },
      {
        label: "saveStreamSettings",
        invoke: (c) => c.saveStreamSettings({ bitrate: 1000 }),
      },
      { label: "listAccounts", invoke: (c) => c.listAccounts() },
      {
        label: "createApiKeyAccount",
        invoke: (c) =>
          c.createApiKeyAccount("openai", { label: "OpenAI", apiKey: "key" }),
      },
      {
        label: "patchAccount",
        invoke: (c) =>
          c.patchAccount("openai", "account-1", { label: "Updated" }),
      },
      {
        label: "deleteAccount",
        invoke: (c) => c.deleteAccount("openai", "account-1"),
      },
      {
        label: "testAccount",
        invoke: (c) => c.testAccount("openai", "account-1"),
      },
      {
        label: "refreshAccountUsage",
        invoke: (c) => c.refreshAccountUsage("openai", "account-1"),
      },
      {
        label: "startAccountOAuth",
        invoke: (c) => c.startAccountOAuth("discord", { redirect: "app" }),
      },
      {
        label: "submitAccountOAuthCode",
        invoke: (c) => c.submitAccountOAuthCode("discord", { code: "abc" }),
      },
      {
        label: "cancelAccountOAuth",
        invoke: (c) => c.cancelAccountOAuth("discord", { sessionId: "s" }),
      },
      {
        label: "patchProviderStrategy",
        invoke: (c) => c.patchProviderStrategy("openai", { strategy: "pool" }),
      },
    ];

    for (const entry of cases) {
      await runRouteSmoke(client, entry.label, entry.invoke);
    }

    expect(calls.length).toBeGreaterThan(140);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/api/config",
          method: "GET",
        }),
        expect.objectContaining({
          path: "/api/provider/switch",
          method: "POST",
        }),
        expect.objectContaining({
          path: "/api/security/audit?type=secrets&severity=high&since=2026-01-01T00%3A00%3A00.000Z&limit=10",
          method: "GET",
        }),
        expect.objectContaining({
          path: "/api/orchestrator/accounts/readiness?rotation=1",
          method: "GET",
        }),
        expect.objectContaining({
          path: "/api/stream/overlay-layout?destination=destination-1",
          method: "POST",
        }),
      ]),
    );

    expect(chunkPtyInput("a".repeat(MAX_PTY_INPUT_CHUNK_LENGTH + 2))).toEqual([
      "a".repeat(MAX_PTY_INPUT_CHUNK_LENGTH),
      "aa",
    ]);
    expect(chunkPtyInput(`a${String.fromCodePoint(0x1f680)}b`, 2)).toEqual([
      "a",
      String.fromCodePoint(0x1f680),
      "b",
    ]);
  });
});
