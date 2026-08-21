/**
 * Keyless catalog coverage for the plugin-mcp action and route surface. Runs on
 * the pr-deterministic lane under the model provider.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import type {
  CapturedAction,
  ScenarioContext,
  ScenarioModelFixture,
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
const receiptPath = resolve(
  tmpdir(),
  `eliza-scenario-mcp-${process.pid}.jsonl`,
);

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

const PLANNER_TOOL_NAMES = [
  "MCP",
  "MCP_CALL_TOOL",
  "MCP_READ_RESOURCE",
  "MCP_SEARCH_ACTIONS",
  "MCP_LIST_CONNECTIONS",
  "REPLY",
  "IGNORE",
  "STOP",
] as const;

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function actionRouteModelFixtures(
  route: (typeof strictMcpRoutes)[number],
): ScenarioModelFixture[] {
  const slug = route.actionName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return [
    {
      name: `route-${slug}-stage1-${route.input}`,
      match: {
        modelType: "RESPONSE_HANDLER",
        input: { includes: route.input },
        toolNames: ["HANDLE_RESPONSE"],
      },
      response: {
        json: {
          contexts: [...route.contextIds],
          intents: [route.input.toLowerCase()],
          replyText: route.messageToUser,
          threadOps: [],
          candidateActionNames: [route.actionName],
        },
      },
    },
    {
      name: `route-${slug}-planner-${route.input}`,
      match: {
        modelType: "ACTION_PLANNER",
        input: { includes: route.input },
        toolNames: PLANNER_TOOL_NAMES,
      },
      response: {
        json: {
          text: "",
          thought: `Call ${route.actionName} for ${route.input}.`,
          messageToUser: route.messageToUser,
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
}

function unsupportedMcpModelFixtures(
  input: string,
  op: "search_actions" | "list_connections",
): ScenarioModelFixture[] {
  const text = `MCP op=${op} is only available in the cloud runtime.`;
  return [
    {
      name: `mcp-unsupported-${op}-evaluator-${input}`,
      match: {
        modelType: "RESPONSE_HANDLER",
        input: {
          pattern: `^(?=[\\s\\S]*${regexEscape(input)})(?=[\\s\\S]*event:message_handler:)(?=[\\s\\S]*Stage 1 router marked this current turn as requiring a tool)[\\s\\S]*$`,
        },
        toolNames: [],
      },
      response: {
        json: {
          success: false,
          decision: "FINISH",
          thought: `The ${op} action reported the local-runtime boundary.`,
          messageToUser: text,
        },
      },
    },
    {
      name: `mcp-unsupported-${op}-failure-synthesis-${input}`,
      match: {
        modelType: "ACTION_PLANNER",
        input: { includes: input },
        toolNames: [],
      },
      response: {
        json: {
          text,
          thought: `Report the ${op} local-runtime boundary.`,
          messageToUser: text,
          completed: true,
          finishReason: "stop",
          toolCalls: [],
        },
      },
    },
  ];
}

const modelFixtures: ScenarioModelFixture[] = [
  ...strictMcpRoutes.flatMap(actionRouteModelFixtures),
  {
    name: "mcp-resource-analysis",
    match: {
      modelType: "TEXT_SMALL",
      prompt: {
        pattern: `^(?=[\\s\\S]*${regexEscape(RESOURCE_URI)})(?=[\\s\\S]*${regexEscape(RESOURCE_TEXT)})[\\s\\S]*$`,
      },
    },
    response: { text: RESOURCE_ANALYSIS_TEXT },
  },
  {
    name: "mcp-tool-selection-arguments",
    match: {
      modelType: "TEXT_LARGE",
      prompt: {
        pattern: `^(?=[\\s\\S]*# TASK: Generate Tool Arguments for Tool Execution)(?=[\\s\\S]*${TOOL_NAME})(?=[\\s\\S]*"code")[\\s\\S]*$`,
      },
    },
    response: {
      json: {
        toolArguments: { code: TOOL_CODE },
        reasoning: "The requested code is alpha-42.",
      },
    },
  },
  {
    name: "mcp-tool-reasoning",
    match: {
      modelType: "TEXT_SMALL",
      prompt: {
        pattern: `^(?=[\\s\\S]*Synthesize the result from the "${TOOL_NAME}" tool)(?=[\\s\\S]*${regexEscape(TOOL_OUTPUT)})[\\s\\S]*$`,
      },
    },
    response: { text: TOOL_REASONING_TEXT },
  },
  ...unsupportedMcpModelFixtures(
    parentListConnectionsInput,
    "list_connections",
  ),
  ...unsupportedMcpModelFixtures(searchActionsInput, "search_actions"),
  ...unsupportedMcpModelFixtures(listConnectionsInput, "list_connections"),
];

type RuntimeWithMcpScenario = IAgentRuntime & {
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
  setSetting: (key: string, value: unknown, secret?: boolean) => void;
};

type RouteStatusBody = {
  ok?: unknown;
  servers?: unknown;
};

let scenarioRuntime: RuntimeWithMcpScenario | null = null;
let previousEvaluators: IAgentRuntime["evaluators"] | null = null;
let previousMcpSetting: unknown;

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
          env: { SCENARIO_MCP_RECEIPT_PATH: receiptPath },
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
  rmSync(receiptPath, { force: true });
  if (!fixtureSource.includes(RESOURCE_TEXT)) {
    return `MCP fixture source does not contain ${RESOURCE_TEXT}`;
  }

  previousMcpSetting = runtime.getSetting("mcp");
  runtime.setSetting("mcp", mcpConfig().mcp, false);
  // Post-turn evaluators are outside this MCP contract. Keep the manifest
  // limited to the message loop and MCP-owned model calls, then restore them in
  // cleanup so a shared runtime cannot leak the isolation choice.
  previousEvaluators = runtime.evaluators;
  runtime.evaluators = [];

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
  if (process.env.ELIZA_SCENARIO_MCP_FAIL_AFTER_CONNECT === "1") {
    return "forced MCP post-connect failure for teardown verification";
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
  const receiptFailure = expectMcpReceipts();
  if (receiptFailure) return receiptFailure;
  return undefined;
}

type McpReceipt = {
  direction?: unknown;
  method?: unknown;
  payload?: unknown;
  pid?: unknown;
};

function readMcpReceipts(): McpReceipt[] {
  if (!existsSync(receiptPath)) return [];
  return readFileSync(receiptPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as McpReceipt);
}

function expectMcpReceipts(): string | undefined {
  const receipts = readMcpReceipts();
  for (const method of [
    "tools/list",
    "resources/list",
    "resources/templates/list",
    "resources/read",
    "tools/call",
  ]) {
    for (const direction of ["request", "response"]) {
      if (
        !receipts.some(
          (receipt) =>
            receipt.direction === direction && receipt.method === method,
        )
      ) {
        return `missing MCP ${direction} receipt for ${method}: ${stableStringify(receipts)}`;
      }
    }
  }
  return undefined;
}

async function stopMcpAndProveNoOrphan(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime =
    (ctx.runtime as RuntimeWithMcpScenario | undefined) ?? scenarioRuntime;
  if (runtime && previousEvaluators) {
    runtime.evaluators = previousEvaluators;
    previousEvaluators = null;
  }
  runtime?.setSetting("mcp", previousMcpSetting, false);
  previousMcpSetting = undefined;
  const service = runtime?.getService<McpService>(MCP_SERVICE_NAME);
  const started = readMcpReceipts().find(
    (receipt) =>
      receipt.direction === "lifecycle" && receipt.method === "started",
  );
  const pid = typeof started?.pid === "number" ? started.pid : null;
  await service?.stop();
  if (pid === null) return "MCP fixture did not record its child pid";

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return undefined;
      return `MCP orphan probe failed for pid ${pid}: ${String(error)}`;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return `MCP fixture process ${pid} remained alive after service.stop()`;
}

export default scenario({
  id: "deterministic-mcp-actions-routes",
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "fixtures",
    fixtures: [...modelFixtures],
  },
  title: "Deterministic MCP action and route coverage",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "zero-cost", "mcp", "routes"],
  isolation: "shared-runtime",
  requires: {
    services: [MCP_SERVICE_NAME],
  },
  seed: [
    {
      type: "custom",
      name: "start real stdio MCP fixture and register strict resource-analysis fixture",
      apply: seedMcp,
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "stop the MCP stdio fixture and prove its child process exited",
      apply: stopMcpAndProveNoOrphan,
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
