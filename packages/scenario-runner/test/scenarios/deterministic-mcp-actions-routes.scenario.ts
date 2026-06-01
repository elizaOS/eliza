import { readFileSync } from "node:fs";
import type http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type IAgentRuntime, ModelType, type Plugin } from "@elizaos/core";
import type {
  CapturedAction,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import mcpPlugin, {
  handleMcpRoutes,
  type McpRouteConfig,
} from "../../../../plugins/plugin-mcp/src/index.ts";
import type { McpService } from "../../../../plugins/plugin-mcp/src/service.ts";
import {
  MCP_SERVICE_NAME,
  type McpServer,
} from "../../../../plugins/plugin-mcp/src/types.ts";
import {
  matchesScenarioInput,
  type RuntimeWithScenarioLlmFixtures,
  registerStrictActionRouteFixtures,
} from "./_helpers/strict-llm-action-fixtures";

const MCP_SERVER_NAME = "scenario_mcp";
const TOOL_NAME = "echo_code";
const TOOL_CODE = "alpha-42";
const TOOL_OUTPUT = `mcp-tool-echo:${TOOL_CODE}`;
const TOOL_REASONING_TEXT = "mcp-tool-analysis: alpha-42 echoed";
const RESOURCE_URI = "fixture://mcp-note";
const RESOURCE_TEXT = "mcp-resource-note:alpha-42";
const RESOURCE_ANALYSIS_TEXT = "mcp-resource-analysis: alpha-42 is present";
const readResourceInput = `Fetch the ${RESOURCE_URI} MCP resource file from the scenario MCP server.`;
const callToolInput = `Execute the scenario MCP ${TOOL_NAME} tool with ${TOOL_CODE}.`;
const parentListConnectionsInput =
  "Fetch deterministic MCP connections through the parent action.";
const searchActionsInput = "Search deterministic MCP actions.";
const listConnectionsInput = "Fetch deterministic MCP connections.";
const scenarioDir = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(scenarioDir, "../fixtures/mcp-stdio-fixture.mjs");
const fixtureSource = readFileSync(fixturePath, "utf8");

type JsonRecord = Record<string, unknown>;

const readResourceParameters = {
  action: "read_resource",
  serverName: MCP_SERVER_NAME,
  uri: RESOURCE_URI,
};

const callToolParameters = {
  action: "call_tool",
  serverName: MCP_SERVER_NAME,
  toolName: TOOL_NAME,
};

const parentListConnectionsParameters = {
  action: "list_connections",
};

const searchActionsParameters = {
  action: "search_actions",
  query: "echo",
};

const listConnectionsParameters = {
  action: "list_connections",
};

const strictMcpRoutes = [
  {
    actionName: "MCP_READ_RESOURCE",
    args: readResourceParameters,
    contextIds: ["mcp"],
    input: readResourceInput,
    messageToUser: RESOURCE_ANALYSIS_TEXT,
  },
  {
    actionName: "MCP_CALL_TOOL",
    args: callToolParameters,
    contextIds: ["mcp"],
    input: callToolInput,
    messageToUser: TOOL_REASONING_TEXT,
  },
  {
    actionName: "MCP",
    args: parentListConnectionsParameters,
    contextIds: ["mcp"],
    input: parentListConnectionsInput,
    messageToUser:
      "MCP op=list_connections is only available in the cloud runtime.",
  },
  {
    actionName: "MCP_SEARCH_ACTIONS",
    args: searchActionsParameters,
    contextIds: ["mcp"],
    input: searchActionsInput,
    messageToUser:
      "MCP op=search_actions is only available in the cloud runtime.",
  },
  {
    actionName: "MCP_LIST_CONNECTIONS",
    args: listConnectionsParameters,
    contextIds: ["mcp"],
    input: listConnectionsInput,
    messageToUser:
      "MCP op=list_connections is only available in the cloud runtime.",
  },
];

function matchesUnsupportedMcpEvaluation(expectedInput: string) {
  const matchesInput = matchesScenarioInput(expectedInput);
  return (value: string) =>
    matchesInput(value) &&
    value.includes("event:message_handler:") &&
    value.includes(
      "Stage 1 router marked this current turn as requiring a tool",
    );
}

function unsupportedMcpEvaluationFixture(input: string, op: string) {
  const text = `MCP op=${op} is only available in the cloud runtime.`;
  return {
    name: `mcp-unsupported-${op}-evaluator-${input}`,
    match: {
      modelType: ModelType.RESPONSE_HANDLER,
      input: matchesUnsupportedMcpEvaluation(input),
    },
    response: {
      success: false,
      decision: "FINISH",
      thought: `The ${op} action reported the local-runtime boundary.`,
      messageToUser: text,
    },
    times: 1,
  };
}

type RuntimeWithMcpScenario = IAgentRuntime &
  RuntimeWithScenarioLlmFixtures & {
    plugins?: Plugin[];
    getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
    registerPlugin: (plugin: Plugin) => Promise<void>;
    routes?: Array<{
      type?: string;
      path: string;
      handler?: (
        req: http.IncomingMessage,
        res: http.ServerResponse,
        runtime: unknown,
      ) => Promise<void> | void;
      __scenarioMcpRoute?: boolean;
    }>;
    scenarioLlmFixtures?: {
      register: (...fixtures: Array<Record<string, unknown>>) => void;
    };
    setSetting: (key: string, value: unknown, secret?: boolean) => void;
  };

type RouteStatusBody = {
  ok?: unknown;
  servers?: unknown;
};

let scenarioRuntime: RuntimeWithMcpScenario | null = null;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
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
  return JSON.stringify(value) ?? String(value);
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    current = isRecord(current) ? current[segment] : undefined;
  }
  return current;
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

function actionParameters(action: CapturedAction): JsonRecord {
  return toRecord(action.parameters);
}

function expectActionParameters(
  action: CapturedAction,
  expectedParameters: JsonRecord,
): string | undefined {
  const actual = actionParameters(action);
  const parameters = isRecord(actual.parameters) ? actual.parameters : actual;
  return expectEqual(
    parameters,
    expectedParameters,
    `${action.actionName} handler parameters`,
  );
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

function expectMcpReadResourceAction(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = firstAction(execution, "MCP_READ_RESOURCE");
  if (typeof action === "string") return action;
  const parametersFailure = expectActionParameters(
    action,
    readResourceParameters,
  );
  if (parametersFailure) return parametersFailure;

  const params = actionParameters(action);
  for (const [path, expected] of Object.entries({
    "parameters.action": "read_resource",
    "parameters.serverName": MCP_SERVER_NAME,
    "parameters.uri": RESOURCE_URI,
  })) {
    const failure = expectEqual(readPath(params, path), expected, path);
    if (failure) return failure;
  }

  if (action.result?.success !== true) {
    return `expected MCP_READ_RESOURCE result.success=true, saw ${stableStringify(action.result)}`;
  }
  if (action.result.text !== `Successfully read resource: ${RESOURCE_URI}`) {
    return `expected MCP_READ_RESOURCE success text, saw ${JSON.stringify(action.result.text)}`;
  }
  for (const [path, expected] of Object.entries({
    "data.actionName": "MCP",
    "data.op": "read_resource",
    "data.serverName": MCP_SERVER_NAME,
    "data.uri": RESOURCE_URI,
    "values.resourceRead": true,
    "values.serverName": MCP_SERVER_NAME,
    "values.uri": RESOURCE_URI,
  })) {
    const failure = expectEqual(readPath(action.result, path), expected, path);
    if (failure) return failure;
  }
  if (
    Number(readPath(action.result, "data.contentLength")) !==
    RESOURCE_TEXT.length
  ) {
    return `expected contentLength=${RESOURCE_TEXT.length}, saw ${String(readPath(action.result, "data.contentLength"))}`;
  }
  if (!execution.responseText?.includes(RESOURCE_ANALYSIS_TEXT)) {
    return `expected deterministic MCP resource analysis response, saw ${JSON.stringify(execution.responseText)}`;
  }
  return undefined;
}

function expectMcpCallToolAction(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = firstAction(execution, "MCP_CALL_TOOL");
  if (typeof action === "string") return action;
  const parametersFailure = expectActionParameters(action, callToolParameters);
  if (parametersFailure) return parametersFailure;

  if (action.result?.success !== true) {
    return `expected MCP_CALL_TOOL result.success=true, saw ${stableStringify(action.result)}`;
  }
  if (
    action.result.text !==
    `Successfully called tool: ${MCP_SERVER_NAME}/${TOOL_NAME}. Reasoned response: ${TOOL_REASONING_TEXT}`
  ) {
    return `expected MCP_CALL_TOOL success text, saw ${JSON.stringify(action.result.text)}`;
  }
  for (const [path, expected] of Object.entries({
    "data.actionName": "MCP",
    "data.op": "call_tool",
    "data.serverName": MCP_SERVER_NAME,
    "data.toolName": TOOL_NAME,
    "data.toolArgumentsJson": JSON.stringify({ code: TOOL_CODE }),
    "data.output": TOOL_OUTPUT,
    "values.toolExecuted": true,
    "values.serverName": MCP_SERVER_NAME,
    "values.toolName": TOOL_NAME,
    "values.output": TOOL_OUTPUT,
  })) {
    const failure = expectEqual(readPath(action.result, path), expected, path);
    if (failure) return failure;
  }
  if (!execution.responseText?.includes(TOOL_REASONING_TEXT)) {
    return `expected deterministic MCP tool reasoning response, saw ${JSON.stringify(execution.responseText)}`;
  }
  return undefined;
}

function expectUnsupportedMcpCloudOp(
  actionName: "MCP" | "MCP_SEARCH_ACTIONS" | "MCP_LIST_CONNECTIONS",
  op: "search_actions" | "list_connections",
  expectedParameters: JsonRecord,
): (execution: ScenarioTurnExecution) => string | undefined {
  return (execution) => {
    const action = firstAction(execution, actionName);
    if (typeof action === "string") return action;
    const parametersFailure = expectActionParameters(
      action,
      expectedParameters,
    );
    if (parametersFailure) return parametersFailure;
    const text = `MCP op=${op} is only available in the cloud runtime.`;
    if (action.result?.success !== false) {
      return `expected ${actionName} result.success=false, saw ${stableStringify(action.result)}`;
    }
    for (const [path, expected] of Object.entries({
      text,
      "data.actionName": "MCP",
      "data.op": op,
      "values.error": "OP_NOT_SUPPORTED",
    })) {
      const failure = expectEqual(
        readPath(action.result, path),
        expected,
        path,
      );
      if (failure) return failure;
    }
    return execution.responseText === text
      ? undefined
      : `expected ${actionName} response ${JSON.stringify(text)}, saw ${JSON.stringify(execution.responseText)}`;
  };
}

function mcpConfig(): McpRouteConfig {
  return {
    mcp: {
      servers: {
        [MCP_SERVER_NAME]: {
          type: "stdio",
          command: "node",
          args: [fixturePath],
          timeoutInMillis: 5_000,
        },
      },
    },
  };
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, message: string, status = 500): void {
  json(res, { ok: false, error: message }, status);
}

async function readJsonBody<T extends object>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<T | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    error(
      res,
      `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      400,
    );
    return null;
  }
}

function isBlockedObjectKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function cloneWithoutBlockedObjectKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneWithoutBlockedObjectKeys(entry)) as T;
  }
  if (!isRecord(value)) return value;
  const out: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isBlockedObjectKey(key))
      out[key] = cloneWithoutBlockedObjectKeys(entry);
  }
  return out as T;
}

function getMcpRouteRuntime(runtime: RuntimeWithMcpScenario) {
  return {
    getService(name: string): unknown {
      return runtime.getService(name === "MCP" ? MCP_SERVICE_NAME : name);
    },
  };
}

async function scenarioMcpRouteHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: unknown,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const scenarioRuntime = runtime as RuntimeWithMcpScenario;
  const handled = await handleMcpRoutes({
    req,
    res,
    method,
    pathname: url.pathname,
    url,
    state: {
      config: mcpConfig(),
      runtime: getMcpRouteRuntime(scenarioRuntime),
    },
    json,
    error,
    readJsonBody,
    saveElizaConfig: () => undefined,
    redactDeep: (value) => value,
    isBlockedObjectKey,
    cloneWithoutBlockedObjectKeys,
    resolveMcpServersRejection: async () => null,
    resolveMcpTerminalAuthorizationRejection: () => null,
    decodePathComponent: (raw, response, label) => {
      try {
        return decodeURIComponent(raw);
      } catch {
        error(response, `Invalid ${label}`, 400);
        return null;
      }
    },
  });
  if (!handled && !res.headersSent) {
    error(res, `No MCP route handled ${method} ${url.pathname}`, 404);
  }
}

function registerMcpRoutes(runtime: RuntimeWithMcpScenario): void {
  const routes = runtime.routes ?? [];
  runtime.routes = routes.filter((route) => route.__scenarioMcpRoute !== true);
  for (const [type, path] of [
    ["GET", "/api/mcp/status"],
    ["GET", "/api/mcp/config"],
  ] as const) {
    runtime.routes.push({
      type,
      path,
      handler: scenarioMcpRouteHandler,
      __scenarioMcpRoute: true,
    });
  }
}

async function seedMcp(ctx: ScenarioContext): Promise<string | undefined> {
  const runtime = ctx.runtime as RuntimeWithMcpScenario | undefined;
  if (!runtime) return "scenario runtime was not available";
  scenarioRuntime = runtime;
  if (!fixtureSource.includes(RESOURCE_TEXT)) {
    return `MCP fixture source does not contain ${RESOURCE_TEXT}`;
  }

  runtime.setSetting("mcp", mcpConfig().mcp, false);
  registerStrictActionRouteFixtures(runtime, strictMcpRoutes);
  runtime.scenarioLlmFixtures?.register(
    {
      name: "mcp-resource-analysis",
      match: {
        modelType: ModelType.TEXT_SMALL,
        prompt: (prompt: string) =>
          prompt.includes(RESOURCE_URI) && prompt.includes(RESOURCE_TEXT),
      },
      response: RESOURCE_ANALYSIS_TEXT,
      times: 1,
    },
    {
      name: "mcp-tool-selection-name",
      match: {
        modelType: ModelType.TEXT_LARGE,
        prompt: (prompt: string) =>
          prompt.includes(
            "# TASK: Select the Most Appropriate Tool and Server",
          ) &&
          prompt.includes(MCP_SERVER_NAME) &&
          prompt.includes(TOOL_NAME),
      },
      response: JSON.stringify({
        serverName: MCP_SERVER_NAME,
        toolName: TOOL_NAME,
        reasoning:
          "The user asked to echo alpha-42 through the deterministic MCP fixture.",
        noToolAvailable: false,
      }),
      times: 1,
    },
    {
      name: "mcp-tool-selection-arguments",
      match: {
        modelType: ModelType.TEXT_LARGE,
        prompt: (prompt: string) =>
          prompt.includes(
            "# TASK: Generate Tool Arguments for Tool Execution",
          ) &&
          prompt.includes(TOOL_NAME) &&
          prompt.includes('"code"'),
      },
      response: JSON.stringify({
        toolArguments: { code: TOOL_CODE },
        reasoning: "The requested code is alpha-42.",
      }),
      times: 1,
    },
    {
      name: "mcp-tool-reasoning",
      match: {
        modelType: ModelType.TEXT_SMALL,
        prompt: (prompt: string) =>
          prompt.includes(
            `Synthesize the result from the "${TOOL_NAME}" tool`,
          ) && prompt.includes(TOOL_OUTPUT),
      },
      response: TOOL_REASONING_TEXT,
      times: 1,
    },
    unsupportedMcpEvaluationFixture(
      parentListConnectionsInput,
      "list_connections",
    ),
    unsupportedMcpEvaluationFixture(searchActionsInput, "search_actions"),
    unsupportedMcpEvaluationFixture(listConnectionsInput, "list_connections"),
  );

  const registered = (runtime.plugins ?? []).some(
    (plugin) => plugin.name === mcpPlugin.name,
  );
  if (!registered) {
    await runtime.registerPlugin(mcpPlugin);
  }
  const service =
    ((await runtime.getServiceLoadPromise?.(MCP_SERVICE_NAME)) as
      | McpService
      | undefined) ?? runtime.getService<McpService>(MCP_SERVICE_NAME);
  await service?.waitForInitialization?.();
  const server = service
    ?.getServers()
    .find((candidate) => candidate.name === MCP_SERVER_NAME);
  if (!server) return `MCP server ${MCP_SERVER_NAME} was not registered`;
  if (server.status !== "connected") {
    return `MCP server ${MCP_SERVER_NAME} status was ${server.status}`;
  }
  registerMcpRoutes(runtime);
  return undefined;
}

function expectMcpStatus(status: number, body: unknown): string | undefined {
  if (status !== 200) return `expected status 200, saw ${status}`;
  const response = body as RouteStatusBody;
  if (response.ok !== true) {
    return `expected ok=true, saw ${stableStringify(body)}`;
  }
  const servers = Array.isArray(response.servers) ? response.servers : [];
  const server = servers.find(
    (candidate) => readPath(candidate, "name") === MCP_SERVER_NAME,
  );
  if (!server) {
    return `expected ${MCP_SERVER_NAME} in MCP status body, saw ${stableStringify(body)}`;
  }
  for (const [path, expected] of Object.entries({
    name: MCP_SERVER_NAME,
    status: "connected",
    toolCount: 1,
    resourceCount: 1,
  })) {
    const failure = expectEqual(
      readPath(server, path),
      expected,
      `server.${path}`,
    );
    if (failure) return failure;
  }
  return undefined;
}

async function finalMcpCheck(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime =
    (ctx.runtime as RuntimeWithMcpScenario | undefined) ?? scenarioRuntime;
  if (!runtime) return "scenario runtime was not available in final check";
  const service = runtime.getService<McpService>(MCP_SERVICE_NAME);
  if (!service) return "McpService was not registered";
  const server = service
    .getServers()
    .find((candidate: McpServer) => candidate.name === MCP_SERVER_NAME);
  if (!server) return `expected ${MCP_SERVER_NAME}, saw no MCP servers`;
  if ((server.tools?.length ?? 0) !== 1) {
    return `expected one MCP tool, saw ${server.tools?.length ?? 0}`;
  }
  if ((server.resources?.length ?? 0) !== 1) {
    return `expected one MCP resource, saw ${server.resources?.length ?? 0}`;
  }
  if (readPath(server.resources?.[0], "uri") !== RESOURCE_URI) {
    return `expected MCP resource uri ${RESOURCE_URI}, saw ${stableStringify(server.resources)}`;
  }
  await service.stop();
  return undefined;
}

export default scenario({
  id: "deterministic-mcp-actions-routes",
  title: "Deterministic MCP action and route coverage",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "zero-cost", "mcp", "routes"],
  isolation: "shared-runtime",
  requires: {
    plugins: ["@elizaos/plugin-mcp"],
  },
  seed: [
    {
      type: "custom",
      name: "start real stdio MCP fixture and register strict resource-analysis fixture",
      apply: seedMcp,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "mcp",
      title: "Deterministic MCP Actions",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "read deterministic MCP resource through promoted virtual action",
      text: readResourceInput,
      assertTurn: expectMcpReadResourceAction,
    },
    {
      kind: "message",
      name: "call deterministic MCP tool through promoted virtual action",
      text: callToolInput,
      assertTurn: expectMcpCallToolAction,
    },
    {
      kind: "message",
      name: "parent MCP action reports local-only list-connections boundary",
      text: parentListConnectionsInput,
      assertTurn: expectUnsupportedMcpCloudOp(
        "MCP",
        "list_connections",
        parentListConnectionsParameters,
      ),
    },
    {
      kind: "message",
      name: "MCP search-actions virtual action reports local-only boundary",
      text: searchActionsInput,
      assertTurn: expectUnsupportedMcpCloudOp(
        "MCP_SEARCH_ACTIONS",
        "search_actions",
        searchActionsParameters,
      ),
    },
    {
      kind: "message",
      name: "MCP list-connections virtual action reports local-only boundary",
      text: listConnectionsInput,
      assertTurn: expectUnsupportedMcpCloudOp(
        "MCP_LIST_CONNECTIONS",
        "list_connections",
        listConnectionsParameters,
      ),
    },
    {
      kind: "api",
      name: "MCP status route reports discovered fixture capabilities",
      method: "GET",
      path: "/api/mcp/status",
      expectedStatus: 200,
      assertResponse: expectMcpStatus,
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "MCP_READ_RESOURCE",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "MCP_CALL_TOOL",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "MCP",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "MCP_SEARCH_ACTIONS",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "MCP_LIST_CONNECTIONS",
      minCount: 1,
    },
    {
      type: "custom",
      name: "real MCP stdio service discovered the fixture tool and resource",
      predicate: finalMcpCheck,
    },
  ],
});
