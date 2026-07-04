/**
 * Keyless coverage of the sub-agent credential-request bridge: a sub-agent's
 * credential request relays back to its origin. Runs on the pr-deterministic lane
 * under the LLM proxy; live-sub-agent-credential-request is the real-model twin.
 */
import type http from "node:http";
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
  type ScenarioTurnExecution,
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

const SCENARIO_ID = "deterministic-sub-agent-credential-request";
const CHILD_SESSION_ID = "scenario-credential-child";
const CHILD_NAME = "Credential Bridge Child";
const OPENAI_KEY = "OPENAI_API_KEY";
const SECOND_KEY = "STRIPE_API_KEY";
const SECRET_VALUE = "sk-scenario-credential-value-10317";
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

const state: {
  scopedToken?: string;
  credentialScopeId?: string;
  sent: Array<{
    content: Content & { text: string };
    target: TargetInfo;
  }>;
} = {
  sent: [],
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

function activeSession(): SessionInfo {
  return {
    id: CHILD_SESSION_ID,
    name: CHILD_NAME,
    agentType: "codex",
    workdir: process.cwd(),
    status: "running",
    approvalPreset: "standard",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    lastActivityAt: new Date("2026-07-01T00:00:01.000Z"),
    metadata: {
      roomId: ROOM_ID,
      channelId: ROOM_ID,
      source: "owner_app",
      ownerEntityId: OWNER_ENTITY_ID,
    },
  };
}

function createScenarioAcpService(): AcpActionService {
  const session = activeSession();
  return {
    async spawnSession() {
      throw new Error("scenario does not spawn external child processes");
    },
    async sendToSession() {
      throw new Error("scenario does not send prompts to child processes");
    },
    async sendKeysToSession() {},
    async stopSession() {},
    listSessions() {
      return [session];
    },
    getSession(sessionId: string) {
      return sessionId === CHILD_SESSION_ID ? session : null;
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
  state.scopedToken = undefined;
  state.credentialScopeId = undefined;

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

function expectUnknownSession(
  status: number,
  body: unknown,
): string | undefined {
  const record = bodyRecord(body);
  if (status !== 410) return `expected 410, saw ${status}`;
  return record.code === "session_not_active"
    ? undefined
    : `expected session_not_active, saw ${JSON.stringify(body)}`;
}

function expectCredentialRequest(
  status: number,
  body: unknown,
): string | undefined {
  const record = bodyRecord(body);
  if (status !== 200) return `expected 200, saw ${status}`;
  if (typeof record.credentialScopeId !== "string") {
    return `expected credentialScopeId, saw ${JSON.stringify(body)}`;
  }
  if (
    typeof record.scopedToken !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.scopedToken)
  ) {
    return "expected a 64-char hex scopedToken";
  }
  if (typeof record.expiresAt !== "number") {
    return `expected numeric expiresAt, saw ${JSON.stringify(record.expiresAt)}`;
  }
  if (
    !Array.isArray(record.sensitiveRequestIds) ||
    record.sensitiveRequestIds.length !== 1 ||
    typeof record.sensitiveRequestIds[0] !== "string"
  ) {
    return `expected one sensitiveRequestId, saw ${JSON.stringify(record.sensitiveRequestIds)}`;
  }

  state.credentialScopeId = record.credentialScopeId;
  state.scopedToken = record.scopedToken;

  const prompt = state.sent.find((entry) =>
    isRecord(entry.content.secretRequest),
  );
  if (!prompt) return "expected owner-app inline sensitive-request message";
  const contentBlob = JSON.stringify(prompt.content);
  if (contentBlob.includes(record.scopedToken)) {
    return "scoped token leaked into owner-app message content";
  }
  if (contentBlob.includes(SECRET_VALUE)) {
    return "credential value leaked into owner-app message content";
  }
  const secretRequest = prompt.content.secretRequest as JsonRecord;
  const delivery = bodyRecord(secretRequest.delivery);
  const tunnel = bodyRecord(delivery.tunnel);
  if (tunnel.credentialScopeId !== record.credentialScopeId) {
    return `expected tunnel scope ${record.credentialScopeId}, saw ${String(tunnel.credentialScopeId)}`;
  }
  if (tunnel.childSessionId !== CHILD_SESSION_ID) {
    return `expected tunnel childSessionId ${CHILD_SESSION_ID}, saw ${String(tunnel.childSessionId)}`;
  }
  const form = bodyRecord(secretRequest.form);
  const fields = Array.isArray(form.fields) ? form.fields : [];
  const names = fields.map((field) =>
    isRecord(field) ? String(field.name) : "",
  );
  return names.includes(OPENAI_KEY) && names.includes(SECOND_KEY)
    ? undefined
    : `expected form fields for both keys, saw ${JSON.stringify(names)}`;
}

function expectTunnelSubmit(status: number, body: unknown): string | undefined {
  const record = bodyRecord(body);
  if (status !== 200) return `expected 200, saw ${status}`;
  if (record.ok !== true)
    return `expected ok=true, saw ${JSON.stringify(body)}`;
  if (record.key !== OPENAI_KEY) {
    return `expected key ${OPENAI_KEY}, saw ${String(record.key)}`;
  }
  const blob = JSON.stringify(body);
  if (blob.includes(SECRET_VALUE)) {
    return "credential value leaked into owner submit response";
  }
  if (state.scopedToken && blob.includes(state.scopedToken)) {
    return "scoped token leaked into owner submit response";
  }
  return undefined;
}

function expectCredentialRedeemed(
  status: number,
  body: unknown,
): string | undefined {
  const record = bodyRecord(body);
  if (status !== 200) return `expected 200, saw ${status}`;
  if (record.key !== OPENAI_KEY) {
    return `expected key ${OPENAI_KEY}, saw ${String(record.key)}`;
  }
  if (record.value !== SECRET_VALUE) {
    return "expected child GET to return the tunneled credential value";
  }
  const resolved = state.sent.find((entry) =>
    entry.content.text?.includes("Credential `OPENAI_API_KEY` received"),
  );
  if (!resolved) return "expected credential resolved follow-up message";
  if (resolved.content.text.includes(SECRET_VALUE)) {
    return "credential value leaked into resolved follow-up message";
  }
  return undefined;
}

function expectReplayRejected(
  status: number,
  body: unknown,
): string | undefined {
  const record = bodyRecord(body);
  if (status !== 403) return `expected 403, saw ${status}`;
  return record.code === "already_redeemed"
    ? undefined
    : `expected already_redeemed, saw ${JSON.stringify(body)}`;
}

function expectNoCredentialLeak(ctx: ScenarioContext): string | undefined {
  const memoryWrites = ctx.memoryWrites ?? [];
  const blob = JSON.stringify(memoryWrites);
  if (blob.includes(SECRET_VALUE)) {
    return "credential value leaked into persisted message memories";
  }
  if (state.scopedToken && blob.includes(state.scopedToken)) {
    return "scoped token leaked into persisted message memories";
  }
  if (!blob.includes("sensitive_request_form")) {
    return "expected persisted sensitive-request form memory";
  }
  if (!blob.includes("Credential `OPENAI_API_KEY` received")) {
    return "expected persisted credential resolved memory";
  }
  return undefined;
}

function expectTurnHasJsonStatus(
  turn: ScenarioTurnExecution,
  expected: number,
): string | undefined {
  return turn.statusCode === expected
    ? undefined
    : `expected statusCode ${expected}, saw ${String(turn.statusCode)}`;
}

export default scenario({
  id: "deterministic-sub-agent-credential-request",
  lane: "pr-deterministic",
  title: "Deterministic sub-agent credential request bridge",
  domain: "agent-orchestrator",
  tags: ["pr", "deterministic", "zero-cost", "credentials", "sub-agent"],
  isolation: "shared-runtime",
  rooms: [
    {
      id: "origin",
      roomId: ROOM_ID,
      worldId: WORLD_ID,
      userId: OWNER_ENTITY_ID,
      source: "owner_app",
      channelType: ChannelType.DM,
      title: "Credential Bridge Origin",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "register real credential tunnel, dispatch adapter, and bridge routes",
      apply: seedCredentialBridge,
    },
  ],
  turns: [
    {
      kind: "api",
      name: "reject credential request for unknown child session",
      method: "POST",
      path: "/api/coding-agents/not-real/credentials/request",
      body: { credentialKeys: [OPENAI_KEY] },
      expectedStatus: 410,
      assertResponse: expectUnknownSession,
      assertTurn: (turn) => expectTurnHasJsonStatus(turn, 410),
    },
    {
      kind: "api",
      name: "child requests scoped credentials and owner receives inline form",
      method: "POST",
      path: `/api/coding-agents/${CHILD_SESSION_ID}/credentials/request`,
      body: { credentialKeys: [OPENAI_KEY, SECOND_KEY] },
      expectedStatus: 200,
      redactResponseFields: ["scopedToken"],
      captures: {
        credentialScopeId: "credentialScopeId",
        scopedToken: "scopedToken",
      },
      assertResponse: expectCredentialRequest,
      assertTurn: (turn) => expectTurnHasJsonStatus(turn, 200),
    },
    {
      kind: "api",
      name: "owner submits one credential through authenticated tunnel route",
      method: "POST",
      path: "/api/credential-tunnel",
      body: {
        childSessionId: CHILD_SESSION_ID,
        credentialScopeId: "{{capture:credentialScopeId}}",
        key: OPENAI_KEY,
        value: SECRET_VALUE,
      },
      expectedStatus: 200,
      assertResponse: expectTunnelSubmit,
      assertTurn: (turn) => expectTurnHasJsonStatus(turn, 200),
    },
    {
      kind: "api",
      name: "child redeems the tunneled credential exactly once",
      method: "GET",
      path: `/api/coding-agents/${CHILD_SESSION_ID}/credentials/${OPENAI_KEY}?token={{capture:scopedToken}}`,
      expectedStatus: 200,
      redactResponseFields: ["value"],
      assertResponse: expectCredentialRedeemed,
      assertTurn: (turn) => expectTurnHasJsonStatus(turn, 200),
    },
    {
      kind: "api",
      name: "replay of redeemed credential is rejected",
      method: "GET",
      path: `/api/coding-agents/${CHILD_SESSION_ID}/credentials/${OPENAI_KEY}?token={{capture:scopedToken}}`,
      expectedStatus: 403,
      assertResponse: expectReplayRejected,
      assertTurn: (turn) => expectTurnHasJsonStatus(turn, 403),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "scoped token and credential value never entered chat memories",
      predicate: expectNoCredentialLeak,
    },
  ],
});
