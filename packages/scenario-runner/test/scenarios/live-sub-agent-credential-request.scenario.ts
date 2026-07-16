/**
 * Live-lane twin of deterministic-sub-agent-credential-request: a real LLM drives
 * the sub-agent credential-request bridge. Needs live model credentials
 * (live-only lane).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  type AgentRuntime,
  ChannelType,
  type Content,
  createMessageMemory,
  createSensitiveRequestDispatchRegistry,
  type IAgentRuntime,
  SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE,
  stringToUuid,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";
import {
  type ScenarioContext,
  scenario,
} from "@elizaos/scenario-runner/schema";
import type { AcpActionService } from "../../../../plugins/plugin-agent-orchestrator/src/actions/common";
import type { SessionInfo } from "../../../../plugins/plugin-agent-orchestrator/src/services/types";
import { codingAgentRoutePlugin } from "../../../../plugins/plugin-agent-orchestrator/src/setup-routes";
import { handleCredentialTunnelRoute } from "../../../app-core/src/api/credential-tunnel-routes";
import {
  createCredentialTunnelService,
  registerSubAgentCredentialBridgeAdapter,
} from "../../../app-core/src/services/credential-tunnel-service";
import { ownerAppInlineSensitiveRequestAdapter } from "../../../app-core/src/services/sensitive-requests/owner-app-inline-adapter";

const SCENARIO_ID = "live-sub-agent-credential-request";
const OPENAI_KEY = "OPENAI_API_KEY";
const SECOND_KEY = "STRIPE_API_KEY";
const SECRET_VALUE = "sk-live-scenario-credential-value-10317";
const ROOM_ID = stringToUuid(`scenario-room:${SCENARIO_ID}:origin`) as UUID;
const WORLD_ID = stringToUuid(`scenario-world:${SCENARIO_ID}`) as UUID;
const OWNER_ENTITY_ID = stringToUuid(`scenario-owner:${SCENARIO_ID}`) as UUID;

type JsonRecord = Record<string, unknown>;

type RuntimeWithScenarioRoutes = AgentRuntime & {
  routes: NonNullable<AgentRuntime["routes"]>;
  registerPlugin?: AgentRuntime["registerPlugin"];
  registerSendHandler?: AgentRuntime["registerSendHandler"];
  services?: Map<string, unknown[]>;
};

type LiveAcpService = {
  start(): Promise<void>;
  stop(): Promise<void>;
  stopSession(sessionId: string): Promise<unknown>;
  spawnSession(input: {
    agentType: string;
    workdir: string;
    name: string;
    timeoutMs: number;
  }): Promise<{ sessionId: string }>;
  sendPrompt(
    sessionId: string,
    prompt: string,
    options: { timeoutMs: number },
  ): Promise<{
    error?: string | null;
    finalText?: string;
    stopReason?: string;
    durationMs?: number;
  }>;
};

const state: {
  liveChildSessionId?: string;
  sent: Array<{
    content: Content & { text: string };
    target: TargetInfo;
  }>;
  submittedScopes: Set<string>;
} = {
  sent: [],
  submittedScopes: new Set(),
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bodyRecord(body: unknown): JsonRecord {
  return isRecord(body) ? body : {};
}

function setRuntimeService(
  runtime: IAgentRuntime,
  serviceName: string,
  service: unknown,
): void {
  const services = (runtime as RuntimeWithScenarioRoutes).services;
  if (!services) {
    throw new Error("scenario runtime did not expose a services map");
  }
  services.set(serviceName, [service]);
}

function activeSession(): SessionInfo | null {
  if (!state.liveChildSessionId) return null;
  return {
    id: state.liveChildSessionId,
    name: "Live Credential Bridge Child",
    agentType: "codex",
    workdir: process.cwd(),
    status: "running",
    approvalPreset: "standard",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    lastActivityAt: new Date(),
    metadata: {
      roomId: ROOM_ID,
      channelId: ROOM_ID,
      source: "owner_app",
      ownerEntityId: OWNER_ENTITY_ID,
    },
  };
}

function createScenarioAcpService(): AcpActionService {
  return {
    async spawnSession() {
      throw new Error("live credential scenario owns the real ACP spawn");
    },
    async sendToSession() {
      throw new Error("live credential scenario owns the real ACP prompt");
    },
    async sendKeysToSession() {},
    async stopSession() {},
    listSessions() {
      const session = activeSession();
      return session ? [session] : [];
    },
    getSession(sessionId: string) {
      const session = activeSession();
      return session?.id === sessionId ? session : null;
    },
  };
}

async function registerScenarioRoutes(
  runtime: RuntimeWithScenarioRoutes,
): Promise<void> {
  runtime.routes ??= [];
  const hasBridgeRoutes = runtime.routes.some(
    (route) =>
      route.path === "/api/coding-agents/:sessionId/credentials/request",
  );
  if (!hasBridgeRoutes && runtime.registerPlugin) {
    await runtime.registerPlugin(codingAgentRoutePlugin);
  } else if (!hasBridgeRoutes) {
    runtime.routes.push(...(codingAgentRoutePlugin.routes ?? []));
  }

  const hasCredentialTunnelRoute = runtime.routes.some(
    (route) => route.path === "/api/credential-tunnel",
  );
  if (!hasCredentialTunnelRoute) {
    runtime.routes.push({
      type: "POST",
      path: "/api/credential-tunnel",
      rawPath: true,
      handler: async (
        req: http.IncomingMessage,
        res: http.ServerResponse,
        agentRuntime: AgentRuntime,
      ) => {
        await handleCredentialTunnelRoute(req, res, {
          current: agentRuntime,
          pendingAgentName: null,
          pendingRestartReasons: [],
        });
      },
    });
  }
}

function registerOwnerAppSendHandler(runtime: RuntimeWithScenarioRoutes): void {
  runtime.registerSendHandler?.(
    "owner_app",
    async (agentRuntime, target, raw) => {
      const text = typeof raw.text === "string" ? raw.text : "";
      const content = { ...raw, text } as Content & { text: string };
      state.sent.push({ target, content });
      const memory = createMessageMemory({
        id: stringToUuid(
          `scenario-message:${SCENARIO_ID}:${state.sent.length}`,
        ) as UUID,
        entityId: agentRuntime.agentId,
        agentId: agentRuntime.agentId,
        roomId: (target.roomId ?? ROOM_ID) as UUID,
        content,
        embedding: new Array(1024).fill(0),
      });
      await agentRuntime.createMemory(memory, "messages");
      return memory;
    },
  );
}

async function seedCredentialBridge(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as RuntimeWithScenarioRoutes | undefined;
  if (!runtime) return "scenario runtime was not available";

  state.sent = [];
  state.liveChildSessionId = undefined;
  state.submittedScopes = new Set();

  try {
    const dispatch =
      (runtime.getService(
        SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE,
      ) as ReturnType<typeof createSensitiveRequestDispatchRegistry> | null) ??
      createSensitiveRequestDispatchRegistry();
    dispatch.register(ownerAppInlineSensitiveRequestAdapter);
    setRuntimeService(
      runtime,
      SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE,
      dispatch,
    );
    setRuntimeService(
      runtime,
      "ACP_SUBPROCESS_SERVICE",
      createScenarioAcpService(),
    );
    registerOwnerAppSendHandler(runtime);
    registerSubAgentCredentialBridgeAdapter(runtime, {
      dispatch,
      tunnel: createCredentialTunnelService(),
      env: {},
    });
    await registerScenarioRoutes(runtime);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function jwtExpMs(jwt: string): number {
  try {
    const payload = jwt.split(".")[1] ?? "";
    const json = JSON.parse(
      Buffer.from(
        payload + "=".repeat((4 - (payload.length % 4)) % 4),
        "base64url",
      ).toString("utf-8"),
    );
    return typeof json.exp === "number"
      ? json.exp * 1000
      : Date.now() + 3600_000;
  } catch {
    return Date.now() + 3600_000;
  }
}

function buildLiveChildPrompt(apiBaseUrl: string, sessionId: string): string {
  const script = `
const fs = require("node:fs/promises");
const baseUrl = ${JSON.stringify(apiBaseUrl)};
const sessionId = ${JSON.stringify(sessionId)};
const key = ${JSON.stringify(OPENAI_KEY)};
const secondKey = ${JSON.stringify(SECOND_KEY)};
const proofPath = "LIVE_CREDENTIAL_BRIDGE_PROOF.json";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

const request = await fetch(baseUrl + "/api/coding-agents/" + encodeURIComponent(sessionId) + "/credentials/request", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ credentialKeys: [key, secondKey] })
});
const scope = await readJson(request);
if (request.status !== 200 || typeof scope.scopedToken !== "string") {
  await fs.writeFile(proofPath, JSON.stringify({ requestedStatus: request.status, redeemed: false, replayStatus: null }, null, 2));
  process.exit(1);
}

let redeemed = null;
let redeemedStatus = 0;
for (let i = 0; i < 45; i += 1) {
  const response = await fetch(baseUrl + "/api/coding-agents/" + encodeURIComponent(sessionId) + "/credentials/" + encodeURIComponent(key) + "?token=" + encodeURIComponent(scope.scopedToken));
  redeemedStatus = response.status;
  if (response.status === 200) {
    redeemed = await readJson(response);
    break;
  }
  await sleep(1000);
}

let replayStatus = null;
let replayCode = null;
if (redeemed) {
  const replay = await fetch(baseUrl + "/api/coding-agents/" + encodeURIComponent(sessionId) + "/credentials/" + encodeURIComponent(key) + "?token=" + encodeURIComponent(scope.scopedToken));
  replayStatus = replay.status;
  const replayBody = await readJson(replay);
  replayCode = replayBody.code ?? null;
}

await fs.writeFile(proofPath, JSON.stringify({
  requestedStatus: request.status,
  redeemed: !!redeemed,
  redeemedStatus,
  key: redeemed?.key ?? key,
  valueRedacted: redeemed?.value ? "[REDACTED]" : null,
  replayStatus,
  replayCode
}, null, 2));
`;

  return [
    "You are part of a live credential bridge verification.",
    "Create and run a Node.js script in the current directory with the exact code below.",
    "Do not print the scoped token or credential value. Do not include either one in your final answer.",
    "After the script writes LIVE_CREDENTIAL_BRIDGE_PROOF.json, reply with only: live-credential-bridge-ok",
    "",
    "```js",
    script.trim(),
    "```",
  ].join("\n");
}

async function submitOwnerCredentialWhenPromptArrives(
  apiBaseUrl: string,
  deadlineMs: number,
): Promise<string | undefined> {
  while (Date.now() < deadlineMs) {
    const prompt = state.sent.find((entry) =>
      isRecord(entry.content.secretRequest),
    );
    const secretRequest = prompt?.content.secretRequest;
    const delivery = bodyRecord(
      isRecord(secretRequest) ? secretRequest.delivery : undefined,
    );
    const tunnel = bodyRecord(delivery.tunnel);
    const credentialScopeId =
      typeof tunnel.credentialScopeId === "string"
        ? tunnel.credentialScopeId
        : "";
    const childSessionId =
      typeof tunnel.childSessionId === "string" ? tunnel.childSessionId : "";
    if (
      credentialScopeId &&
      childSessionId &&
      !state.submittedScopes.has(credentialScopeId)
    ) {
      state.submittedScopes.add(credentialScopeId);
      const response = await fetch(`${apiBaseUrl}/api/credential-tunnel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          childSessionId,
          credentialScopeId,
          key: OPENAI_KEY,
          value: SECRET_VALUE,
        }),
      });
      if (response.status !== 200) {
        const text = await response.text();
        return `owner tunnel submit failed ${response.status}: ${text}`;
      }
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return "timed out waiting for owner-app sensitive request prompt";
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function safeChildFinalText(finalText: unknown): string {
  const text = typeof finalText === "string" ? finalText.trim() : "";
  return text === "live-credential-bridge-ok" ? text : "[REDACTED]";
}

function writeLiveAcpTrajectory(input: {
  prompt: string;
  promptResult: Awaited<ReturnType<LiveAcpService["sendPrompt"]>>;
  startedAt: number;
  proof: JsonRecord;
}): void {
  const trajectoryRoot = process.env.ELIZA_TRAJECTORY_DIR;
  if (!trajectoryRoot) return;

  const endedAt = Date.now();
  const trajectoryId = `live-credential-acp-${SCENARIO_ID}`;
  const stageId = "codex-acp-credential-roundtrip";
  const agentId = "codex-live-credential-child";
  const trajectoryDir = path.join(trajectoryRoot, agentId);
  mkdirSync(trajectoryDir, { recursive: true });
  writeFileSync(
    path.join(trajectoryDir, `${trajectoryId}.json`),
    `${JSON.stringify(
      {
        trajectoryId,
        agentId,
        roomId: ROOM_ID,
        runId: process.env.ELIZA_LIFEOPS_RUN_ID,
        scenarioId: SCENARIO_ID,
        rootMessage: {
          id: `live-credential-root-${SCENARIO_ID}`,
          text: "Live Codex ACP child credential bridge roundtrip",
          sender: "scenario-runner",
        },
        startedAt: input.startedAt,
        endedAt,
        status: "finished",
        stages: [
          {
            stageId,
            kind: "planner",
            startedAt: input.startedAt,
            endedAt,
            latencyMs:
              typeof input.promptResult.durationMs === "number"
                ? input.promptResult.durationMs
                : endedAt - input.startedAt,
            model: {
              modelType: "external_acp_child",
              modelName: "@agentclientprotocol/codex-acp@1.1.2",
              provider: "openai-codex",
              messages: [
                {
                  role: "user",
                  content: input.prompt,
                },
              ],
              response: safeChildFinalText(input.promptResult.finalText),
              finishReason: input.promptResult.stopReason ?? "unknown",
              usage: {
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
              },
              costUsd: 0,
            },
          },
        ],
        metrics: {
          totalLatencyMs: endedAt - input.startedAt,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
          totalCostUsd: 0,
          plannerIterations: 1,
          toolCallsExecuted: input.proof.redeemed === true ? 3 : 0,
          toolCallFailures: 0,
          toolSearchCount: 0,
          evaluatorFailures: 0,
          finalDecision: "FINISH",
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function runLiveCodexCredentialRoundtrip(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  if (process.env.RUN_LIVE_CREDENTIAL_ACP !== "1") {
    return "RUN_LIVE_CREDENTIAL_ACP=1 is required for live credential scenario";
  }
  if (typeof ctx.apiBaseUrl !== "string") {
    return "scenario apiBaseUrl was not available";
  }

  const home = mkdtempSync(path.join(os.tmpdir(), "live-credential-acp-"));
  const previousEnv = {
    ELIZA_HOME: process.env.ELIZA_HOME,
    ELIZA_STATE_DIR: process.env.ELIZA_STATE_DIR,
    ELIZA_ACP_STATE_DIR: process.env.ELIZA_ACP_STATE_DIR,
  };
  process.env.ELIZA_HOME = home;
  process.env.ELIZA_STATE_DIR = home;
  process.env.ELIZA_ACP_STATE_DIR = path.join(home, "acp");

  let acp: LiveAcpService | undefined;
  let sessionId: string | undefined;

  try {
    const authPath = path.join(os.homedir(), ".codex", "auth.json");
    if (!existsSync(authPath)) {
      return "missing ~/.codex/auth.json for live Codex ACP";
    }
    const auth = JSON.parse(readFileSync(authPath, "utf-8")) as JsonRecord;
    const tokens = bodyRecord(auth.tokens);
    const access =
      typeof tokens.access_token === "string" ? tokens.access_token : "";
    const refresh =
      typeof tokens.refresh_token === "string" ? tokens.refresh_token : "";
    const idToken =
      typeof tokens.id_token === "string" ? tokens.id_token : undefined;
    const accountId =
      typeof tokens.account_id === "string" ? tokens.account_id : "";
    if (!access || !accountId) {
      return "~/.codex/auth.json is not a ChatGPT Codex login";
    }

    const { saveAccount } = await import("@elizaos/auth/account-storage");
    saveAccount({
      id: "machine-codex-live-credential",
      providerId: "openai-codex",
      label: "Machine Codex (live credential)",
      source: "oauth",
      credentials: {
        access,
        refresh,
        expires: jwtExpMs(access),
        ...(idToken ? { idToken } : {}),
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      organizationId: accountId,
    });
    const { getDefaultAccountPool } = await import(
      "../../../app-core/src/services/account-pool"
    );
    const { getCodingAgentSelectorBridge } = await import(
      "../../../app-core/src/services/coding-account-bridge"
    );
    getDefaultAccountPool();
    const bridge = getCodingAgentSelectorBridge();
    if (!bridge) {
      return "coding account selector bridge was not installed";
    }

    const { AcpService } = await import(
      "../../../../plugins/plugin-agent-orchestrator/src/services/acp-service"
    );
    const runtime = {
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
      getSetting: (key: string) =>
        ({
          ELIZA_ACP_TRANSPORT: "native",
          ELIZA_CODING_ACCOUNT_STRATEGY: "least-used",
          ACPX_DEFAULT_TIMEOUT_MS: "120000",
        })[key],
      services: new Map(),
    } as never;

    acp = new AcpService(runtime) as LiveAcpService;
    await acp.start();

    const workdir = path.join(home, "workdir");
    const proofPath = path.join(workdir, "LIVE_CREDENTIAL_BRIDGE_PROOF.json");
    const session = await acp.spawnSession({
      agentType: "codex",
      workdir,
      name: "live-credential-bridge",
      timeoutMs: 120_000,
    });
    sessionId = session.sessionId;
    state.liveChildSessionId = session.sessionId;

    const ownerSubmit = submitOwnerCredentialWhenPromptArrives(
      ctx.apiBaseUrl,
      Date.now() + 90_000,
    );
    const childPrompt = buildLiveChildPrompt(ctx.apiBaseUrl, session.sessionId);
    const promptStartedAt = Date.now();
    const promptResult = await acp.sendPrompt(session.sessionId, childPrompt, {
      timeoutMs: 120_000,
    });
    const ownerError = await ownerSubmit;
    if (ownerError) return ownerError;
    if (promptResult.error) {
      return `live Codex prompt failed: ${promptResult.error}`;
    }

    const proofDeadline = Date.now() + 30_000;
    while (Date.now() < proofDeadline && !existsSync(proofPath)) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!existsSync(proofPath)) {
      return "live child did not write credential bridge proof file";
    }
    const proof = JSON.parse(readFileSync(proofPath, "utf-8")) as JsonRecord;
    if (proof.redeemed !== true) {
      return `expected live child redemption proof, saw ${JSON.stringify(proof)}`;
    }
    if (proof.key !== OPENAI_KEY || proof.valueRedacted !== "[REDACTED]") {
      return `unexpected live proof payload: ${JSON.stringify(proof)}`;
    }
    if (proof.replayStatus !== 403 || proof.replayCode !== "already_redeemed") {
      return `expected replay rejection in live proof, saw ${JSON.stringify(proof)}`;
    }
    writeLiveAcpTrajectory({
      prompt: childPrompt,
      promptResult,
      startedAt: promptStartedAt,
      proof,
    });
    if (process.env.LIVE_CREDENTIAL_PROOF_OUT) {
      const evidencePath = process.env.LIVE_CREDENTIAL_PROOF_OUT;
      mkdirSync(path.dirname(evidencePath), { recursive: true });
      writeFileSync(
        evidencePath,
        `${JSON.stringify(
          {
            requestedStatus: proof.requestedStatus,
            redeemed: proof.redeemed,
            redeemedStatus: proof.redeemedStatus,
            key: proof.key,
            valueRedacted: "[REDACTED]",
            replayStatus: proof.replayStatus,
            replayCode: proof.replayCode,
            childFinalText: safeChildFinalText(promptResult.finalText),
            childStopReason: promptResult.stopReason,
            childDurationMs: promptResult.durationMs,
          },
          null,
          2,
        )}\n`,
      );
    }

    const memoryBlob = JSON.stringify(ctx.memoryWrites ?? []);
    if (memoryBlob.includes(SECRET_VALUE)) {
      return "live credential value leaked into persisted message memories";
    }
    if (!memoryBlob.includes("sensitive_request_form")) {
      return "expected live sensitive-request form memory";
    }
    if (!memoryBlob.includes("Credential `OPENAI_API_KEY` received")) {
      return "expected live credential resolved memory";
    }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    if (acp && sessionId) {
      await acp.stopSession(sessionId).catch(() => {});
    }
    if (acp) {
      await withTimeout(acp.stop(), 15_000, "AcpService.stop").catch(() => {});
    }
    state.liveChildSessionId = undefined;
    restoreEnvVar("ELIZA_HOME", previousEnv.ELIZA_HOME);
    restoreEnvVar("ELIZA_STATE_DIR", previousEnv.ELIZA_STATE_DIR);
    restoreEnvVar("ELIZA_ACP_STATE_DIR", previousEnv.ELIZA_ACP_STATE_DIR);
    rmSync(home, { recursive: true, force: true });
  }
}

export default scenario({
  id: "live-sub-agent-credential-request",
  lane: "live-only",
  title: "Live sub-agent credential request bridge",
  domain: "agent-orchestrator",
  tags: ["live", "credentials", "sub-agent", "codex-acp"],
  isolation: "shared-runtime",
  rooms: [
    {
      id: "origin",
      roomId: ROOM_ID,
      worldId: WORLD_ID,
      userId: OWNER_ENTITY_ID,
      source: "owner_app",
      channelType: ChannelType.DM,
      title: "Live Credential Bridge Origin",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "register real credential tunnel, dispatch adapter, and bridge routes",
      apply: seedCredentialBridge,
    },
  ],
  turns: [{ kind: "wait", name: "start loopback server", durationMs: 0 }],
  finalChecks: [
    {
      type: "custom",
      name: "real Codex ACP child redeems tunneled credential once",
      predicate: runLiveCodexCredentialRoundtrip,
    },
  ],
});
