import {
  registerPluginViews,
  unregisterPluginViews,
} from "@elizaos/agent/api/views-registry";
import type {
  Action,
  IAgentRuntime,
  Plugin,
  UUID,
  ViewDeclaration,
} from "@elizaos/core";
import { ModelType, stringToUuid } from "@elizaos/core";
import type {
  CapturedAction,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import WebSocket from "ws";
import {
  XR_SERVICE_TYPE,
  type XRSessionService,
  xrPlugin,
} from "../../../../plugins/plugin-xr/src/index.ts";
import { encodeBinaryFrame } from "../../../../plugins/plugin-xr/src/protocol.ts";
import {
  type RuntimeWithScenarioLlmFixtures,
  registerStrictActionRouteFixtures,
} from "./_helpers/strict-llm-action-fixtures.ts";

const SCENARIO_ID = "deterministic-xr-view-actions";
const ROOM_ID = stringToUuid(`scenario-room:${SCENARIO_ID}:main`) as UUID;
const WORLD_ID = stringToUuid(`scenario-world:${SCENARIO_ID}:main`) as UUID;
const XR_VIEW_ID = "scenario-xr-console";
const XR_VIEW_LABEL = "Scenario XR Console";
const XR_VISION_DESCRIPTION =
  "deterministic-xr-vision: checkerboard frame with scenario console";
const XR_LIST_TEXT = "Show the XR view catalog";
const XR_OPEN_TEXT = `Open "${XR_VIEW_ID}" in XR`;
const XR_SWITCH_TEXT = `Switch the XR view to "${XR_VIEW_ID}"`;
const XR_RESIZE_TEXT = "Resize the XR view panel bigger and closer";
const XR_CLOSE_TEXT = `Close "${XR_VIEW_ID}" in XR`;
const XR_QUERY_VISION_TEXT =
  "Use XR device vision to answer: what do you see through the XR camera?";

type RuntimeWithRegistration = IAgentRuntime &
  RuntimeWithScenarioLlmFixtures & {
    plugins?: Plugin[];
    createRoom: (room: Record<string, unknown>) => Promise<UUID>;
    registerPlugin: (plugin: Plugin) => Promise<void>;
    routes?: Array<{
      path: string;
      routeHandler?: (ctx: Record<string, unknown>) => Promise<{
        status: number;
        body?: unknown;
        headers?: Record<string, string>;
      }>;
    }>;
    setSetting: (key: string, value: string, secret?: boolean) => void;
  };

type ScenarioState = {
  controls: Array<Record<string, unknown>>;
  frameTimer: ReturnType<typeof setInterval> | null;
  modelCalls: Array<{ modelType: string; payload: unknown }>;
  runtime: RuntimeWithRegistration | null;
  service: XRSessionService | null;
  ws: WebSocket | null;
};

const scenarioState: ScenarioState = {
  controls: [],
  frameTimer: null,
  modelCalls: [],
  runtime: null,
  service: null,
  ws: null,
};

const scenarioXrView: ViewDeclaration = {
  id: XR_VIEW_ID,
  label: XR_VIEW_LABEL,
  description:
    "Scenario-only XR view declared through the real plugin registry",
  icon: "BadgeCheck",
  path: "/scenario/xr-console",
  viewType: "xr",
  xrOptions: {
    preferredScale: 1.25,
    preferredDistance: 1.4,
  },
};

const deterministicVisionPlugin: Plugin = {
  name: "scenario-deterministic-xr-vision-model",
  description: "Scenario-only IMAGE_DESCRIPTION handler for XR_QUERY_VISION.",
  priority: 1_000,
  models: {
    [ModelType.IMAGE_DESCRIPTION]: async (_runtime, payload) => {
      scenarioState.modelCalls.push({
        modelType: ModelType.IMAGE_DESCRIPTION,
        payload,
      });
      return XR_VISION_DESCRIPTION;
    },
  },
};

const scenarioXrViewPlugin: Plugin = {
  name: "@scenario/plugin-xr-console",
  description: "Scenario-only plugin contributing a fake registered XR view.",
  views: [scenarioXrView],
};

const scenarioXrActionParameters: Record<
  string,
  NonNullable<Action["parameters"]>
> = {
  XR_LIST_VIEWS: [
    {
      name: "sendCatalog",
      description: "Whether to send the XR view catalog to the headset.",
      required: false,
      schema: { type: "boolean" },
    },
  ],
  XR_OPEN_VIEW: [
    {
      name: "viewId",
      description: "The XR view id to open.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "scale",
      description: "Initial panel scale.",
      required: false,
      schema: { type: "number" },
    },
  ],
  XR_SWITCH_VIEW: [
    {
      name: "viewId",
      description: "The XR view id to foreground.",
      required: true,
      schema: { type: "string" },
    },
  ],
  XR_RESIZE_VIEW: [
    {
      name: "viewId",
      description: "The XR view id to resize.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "scale",
      description: "Requested panel scale.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "distance",
      description: "Requested panel distance in meters.",
      required: false,
      schema: { type: "number" },
    },
  ],
  XR_CLOSE_VIEW: [
    {
      name: "viewId",
      description: "The XR view id to close.",
      required: true,
      schema: { type: "string" },
    },
  ],
  XR_QUERY_VISION: [],
};

function withScenarioXrActionParameters(action: Action): Action {
  const parameters = scenarioXrActionParameters[action.name];
  if (!parameters) return action;
  return {
    ...action,
    parameters,
    handler: (async (runtime, message, state, options, callback, ...rest) => {
      const optionRecord = toRecord(options);
      const nestedParameters = toRecord(optionRecord.parameters);
      const liftedOptions =
        Object.keys(nestedParameters).length > 0 ? nestedParameters : options;
      return action.handler.call(
        action,
        runtime,
        message,
        state,
        liftedOptions,
        callback,
        ...rest,
      );
    }) as Action["handler"],
  };
}

const scenarioXrPlugin: Plugin = {
  ...xrPlugin,
  actions: xrPlugin.actions?.map(withScenarioXrActionParameters),
};

const strictXrViewRoutes = [
  {
    actionName: "XR_LIST_VIEWS",
    args: { sendCatalog: true },
    contextIds: ["xr", "views"],
    input: XR_LIST_TEXT,
    messageToUser: `Available XR views:\n\u2022 ${XR_VIEW_LABEL} (id: ${XR_VIEW_ID})\n\nSay "open [view name]" to launch one.`,
  },
  {
    actionName: "XR_OPEN_VIEW",
    args: { viewId: XR_VIEW_ID, scale: 1.25 },
    contextIds: ["xr", "views"],
    input: XR_OPEN_TEXT,
    messageToUser: `Opening ${XR_VIEW_ID} view on your headset.`,
  },
  {
    actionName: "XR_SWITCH_VIEW",
    args: { viewId: XR_VIEW_ID },
    contextIds: ["xr", "views"],
    input: XR_SWITCH_TEXT,
    messageToUser: `Switched to ${XR_VIEW_ID}.`,
  },
  {
    actionName: "XR_RESIZE_VIEW",
    args: { viewId: XR_VIEW_ID, scale: 1.2, distance: 1.1 },
    contextIds: ["xr", "views"],
    input: XR_RESIZE_TEXT,
    messageToUser: "Panel resized to 1.5\u00d7 at 0.8m.",
  },
  {
    actionName: "XR_CLOSE_VIEW",
    args: { viewId: XR_VIEW_ID },
    contextIds: ["xr", "views"],
    input: XR_CLOSE_TEXT,
    messageToUser: `Closed ${XR_VIEW_ID}.`,
  },
  {
    actionName: "XR_QUERY_VISION",
    args: {},
    contextIds: ["xr", "vision"],
    input: XR_QUERY_VISION_TEXT,
    messageToUser: XR_VISION_DESCRIPTION,
  },
];

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    );
  });
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    current = toRecord(current)[segment];
  }
  return current;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resetScenarioState(): void {
  if (scenarioState.frameTimer) clearInterval(scenarioState.frameTimer);
  scenarioState.frameTimer = null;
  scenarioState.ws?.close();
  scenarioState.ws = null;
  unregisterPluginViews(scenarioXrViewPlugin.name);
  scenarioState.runtime = null;
  scenarioState.service = null;
  scenarioState.controls.length = 0;
  scenarioState.modelCalls.length = 0;
}

function rawMessageToText(data: WebSocket.RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function getWebSocketPort(service: XRSessionService): number | null {
  const wss = (
    service as unknown as {
      wss?: { address?: () => string | { port?: number } | null };
    }
  ).wss;
  const address = wss?.address?.();
  if (!address || typeof address === "string") return null;
  return typeof address.port === "number" ? address.port : null;
}

async function waitForService(
  runtime: RuntimeWithRegistration,
): Promise<XRSessionService> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const service = runtime.getService<XRSessionService>(XR_SERVICE_TYPE);
    if (service && getWebSocketPort(service) !== null) return service;
    await delay(25);
  }
  throw new Error("XRSessionService did not start with an open WebSocket port");
}

function boundXrServiceStop(service: XRSessionService): void {
  const originalStop = service.stop.bind(service);
  let stopped = false;
  service.stop = async () => {
    if (stopped) return;
    stopped = true;
    await Promise.race([originalStop(), delay(1_000)]);
  };
}

function ensureXrRoomsHaveWorldId(runtime: RuntimeWithRegistration): void {
  const originalCreateRoom = runtime.createRoom.bind(runtime);
  runtime.createRoom = ((room: Record<string, unknown>) =>
    originalCreateRoom({
      ...room,
      worldId: typeof room.worldId === "string" ? room.worldId : WORLD_ID,
    })) as RuntimeWithRegistration["createRoom"];
}

function sendFrame(ws: WebSocket): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    encodeBinaryFrame(
      {
        type: "frame",
        ts: Date.now(),
        width: 2,
        height: 2,
        format: "jpeg",
      },
      Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9]),
    ),
  );
}

async function connectScenarioXrClient(
  service: XRSessionService,
): Promise<WebSocket> {
  const port = getWebSocketPort(service);
  if (port === null) {
    throw new Error("XRSessionService WebSocket port was not available");
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    try {
      scenarioState.controls.push(
        JSON.parse(rawMessageToText(data)) as Record<string, unknown>,
      );
    } catch {
      scenarioState.controls.push({ type: "unparseable" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  ws.send(
    JSON.stringify({
      type: "hello",
      deviceType: "simulator",
      sessionId: "scenario-xr-client",
    }),
  );

  const ready = await waitForControl(
    (control) => control.type === "ready",
    "ready handshake",
  );
  if (ready) throw new Error(ready);

  const connection = service.getConnections()[0];
  if (!connection) {
    throw new Error(
      "XRSessionService accepted the socket but has no connection",
    );
  }
  connection.roomId = ROOM_ID;

  sendFrame(ws);
  const frameTimer = setInterval(() => sendFrame(ws), 1_000);
  frameTimer.unref?.();
  scenarioState.frameTimer = frameTimer;

  return ws;
}

async function seedXrScenario(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  resetScenarioState();
  const runtime = ctx.runtime as RuntimeWithRegistration | undefined;
  if (!runtime) return "scenario runtime was not available";
  scenarioState.runtime = runtime;

  runtime.setSetting("XR_WS_PORT", "0", false);
  ensureXrRoomsHaveWorldId(runtime);
  await runtime.registerPlugin(deterministicVisionPlugin);
  await runtime.registerPlugin(scenarioXrViewPlugin);
  await registerPluginViews(scenarioXrViewPlugin, undefined, runtime);
  await runtime.registerPlugin(scenarioXrPlugin);

  const service = await waitForService(runtime);
  boundXrServiceStop(service);
  scenarioState.service = service;
  scenarioState.ws = await connectScenarioXrClient(service);
  registerStrictActionRouteFixtures(runtime, strictXrViewRoutes);

  return undefined;
}

function actionParameters(action: CapturedAction): Record<string, unknown> {
  const params = toRecord(action.parameters);
  return toRecord(params.parameters ?? params);
}

function expectAction(
  execution: ScenarioTurnExecution,
  expected: {
    actionName: string;
    responseText?: string;
    parameters?: Record<string, unknown>;
  },
): string | undefined {
  if (
    expected.responseText !== undefined &&
    execution.responseText !== expected.responseText
  ) {
    return `expected responseText=${JSON.stringify(expected.responseText)}, saw ${JSON.stringify(execution.responseText)}`;
  }

  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === expected.actionName,
  );
  if (!action) {
    return `expected ${expected.actionName} action, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`;
  }
  if (action.result?.success !== true) {
    return `expected ${expected.actionName} result.success=true, saw ${stableStringify(action.result)}`;
  }

  const params = actionParameters(action);
  for (const [key, expectedValue] of Object.entries(
    expected.parameters ?? {},
  )) {
    if (stableStringify(params[key]) !== stableStringify(expectedValue)) {
      return `expected ${expected.actionName} parameter ${key}=${stableStringify(expectedValue)}, saw ${stableStringify(params[key])}`;
    }
  }

  return undefined;
}

async function waitForControl(
  predicate: (control: Record<string, unknown>) => boolean,
  description: string,
): Promise<string | undefined> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (scenarioState.controls.some(predicate)) return undefined;
    await delay(20);
  }
  return `expected XR control ${description}; saw ${stableStringify(scenarioState.controls)}`;
}

async function expectControl(
  predicate: (control: Record<string, unknown>) => boolean,
  description: string,
): Promise<string | undefined> {
  return waitForControl(predicate, description);
}

function controlTypes(): string[] {
  return scenarioState.controls
    .map((control) =>
      typeof control.type === "string" ? control.type : "unknown",
    )
    .filter((type) => type !== "ready");
}

function findRoute(runtime: RuntimeWithRegistration) {
  return runtime.routes?.find(
    (route) =>
      route.path.endsWith("/xr/views") &&
      typeof route.routeHandler === "function",
  );
}

async function finalLedgerCheck(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const names = (ctx.actionsCalled ?? []).map((call) => call.actionName);
  const expectedNames = [
    "XR_LIST_VIEWS",
    "XR_OPEN_VIEW",
    "XR_SWITCH_VIEW",
    "XR_RESIZE_VIEW",
    "XR_CLOSE_VIEW",
    "XR_QUERY_VISION",
  ];
  if (stableStringify(names) !== stableStringify(expectedNames)) {
    return `expected XR action order ${stableStringify(expectedNames)}, saw ${stableStringify(names)}`;
  }

  const expectedControls = [
    "views_catalog",
    "view_open",
    "view_switch",
    "view_resize",
    "view_close",
  ];
  const types = controlTypes();
  if (stableStringify(types) !== stableStringify(expectedControls)) {
    return `expected XR control order ${stableStringify(expectedControls)}, saw ${stableStringify(types)} with controls ${stableStringify(scenarioState.controls)}`;
  }

  const runtime =
    (ctx.runtime as RuntimeWithRegistration | undefined) ??
    scenarioState.runtime;
  if (!runtime) return "scenario runtime was not available in final check";
  const route = findRoute(runtime);
  if (!route?.routeHandler) {
    return `expected registered XR views route, saw routes ${(runtime.routes ?? []).map((candidate) => candidate.path).join(", ")}`;
  }
  const routeResult = await route.routeHandler({
    runtime,
    params: {},
    query: {},
    headers: {},
    method: "GET",
    path: route.path,
    inProcess: true,
  });
  if (routeResult.status !== 200) {
    return `expected XR views route status 200, saw ${routeResult.status}`;
  }
  const body = toRecord(routeResult.body);
  const views = Array.isArray(body.views) ? body.views : [];
  if (
    !views.some(
      (view) =>
        readPath(view, "id") === XR_VIEW_ID &&
        readPath(view, "label") === XR_VIEW_LABEL,
    )
  ) {
    return `expected XR route to include ${XR_VIEW_ID}, saw ${stableStringify(body)}`;
  }
  const connections = Array.isArray(body.connections) ? body.connections : [];
  if (
    !connections.some((conn) => readPath(conn, "deviceType") === "simulator")
  ) {
    return `expected XR route to include simulator connection, saw ${stableStringify(body)}`;
  }

  const modelCall = scenarioState.modelCalls[0];
  if (modelCall?.modelType !== ModelType.IMAGE_DESCRIPTION) {
    return `expected one IMAGE_DESCRIPTION call, saw ${stableStringify(scenarioState.modelCalls)}`;
  }
  const imageUrl = readPath(modelCall.payload, "imageUrl");
  if (
    typeof imageUrl !== "string" ||
    !imageUrl.startsWith("data:image/jpeg;base64,")
  ) {
    return `expected IMAGE_DESCRIPTION data URL payload, saw ${stableStringify(modelCall.payload)}`;
  }
  if (
    readPath(modelCall.payload, "prompt") !==
    "Describe what you see in this image concisely."
  ) {
    return `expected default XR vision prompt, saw ${stableStringify(modelCall.payload)}`;
  }

  return undefined;
}

function cleanupXrClient(): string | undefined {
  resetScenarioState();
  return undefined;
}

export default scenario({
  id: "deterministic-xr-view-actions",
  title: "Deterministic XR view actions with real WebSocket service",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "zero-cost", "xr", "views"],
  isolation: "shared-runtime",
  requires: {
    plugins: ["@elizaos/plugin-xr"],
  },
  seed: [
    {
      type: "custom",
      name: "register real XR plugin, fake XR view, deterministic vision model, and WebSocket client",
      apply: seedXrScenario,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "client_chat",
      title: "Deterministic XR View Actions",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "list XR views",
      text: XR_LIST_TEXT,
      responseIncludesAny: [XR_VIEW_LABEL],
      assertTurn: async (execution) =>
        expectAction(execution, {
          actionName: "XR_LIST_VIEWS",
        }) ??
        (await expectControl(
          (control) =>
            control.type === "views_catalog" &&
            Array.isArray(control.views) &&
            control.views.some(
              (view) =>
                readPath(view, "id") === XR_VIEW_ID &&
                readPath(view, "label") === XR_VIEW_LABEL,
            ),
          "views_catalog containing the scenario XR view",
        )),
    },
    {
      kind: "message",
      name: "open scenario XR view",
      text: XR_OPEN_TEXT,
      responseIncludesAny: [`Opening ${XR_VIEW_ID}`],
      assertTurn: async (execution) =>
        expectAction(execution, {
          actionName: "XR_OPEN_VIEW",
          responseText: `Opening ${XR_VIEW_ID} view on your headset.`,
          parameters: { viewId: XR_VIEW_ID, scale: 1.25 },
        }) ??
        (await expectControl(
          (control) =>
            control.type === "view_open" &&
            control.viewId === XR_VIEW_ID &&
            readPath(control, "config.scale") === 1.25 &&
            readPath(control, "config.followMode") === "billboard" &&
            control.agentBaseUrl === "http://localhost:31337",
          "view_open for the scenario XR view",
        )),
    },
    {
      kind: "message",
      name: "switch scenario XR view",
      text: XR_SWITCH_TEXT,
      responseIncludesAny: [`Switched to ${XR_VIEW_ID}`],
      assertTurn: async (execution) =>
        expectAction(execution, {
          actionName: "XR_SWITCH_VIEW",
          responseText: `Switched to ${XR_VIEW_ID}.`,
          parameters: { viewId: XR_VIEW_ID },
        }) ??
        (await expectControl(
          (control) =>
            control.type === "view_switch" && control.viewId === XR_VIEW_ID,
          "view_switch for the scenario XR view",
        )),
    },
    {
      kind: "message",
      name: "resize scenario XR view",
      text: XR_RESIZE_TEXT,
      responseIncludesAny: ["Panel resized"],
      assertTurn: async (execution) =>
        expectAction(execution, {
          actionName: "XR_RESIZE_VIEW",
          responseText: "Panel resized to 1.5\u00d7 at 0.8m.",
          parameters: { viewId: XR_VIEW_ID, scale: 1.2, distance: 1.1 },
        }) ??
        (await expectControl(
          (control) =>
            control.type === "view_resize" &&
            control.viewId === XR_VIEW_ID &&
            readPath(control, "config.scale") === 1.5 &&
            readPath(control, "config.distance") === 0.8,
          "view_resize for the scenario XR view",
        )),
    },
    {
      kind: "message",
      name: "close scenario XR view",
      text: XR_CLOSE_TEXT,
      responseIncludesAny: [`Closed ${XR_VIEW_ID}`],
      assertTurn: async (execution) =>
        expectAction(execution, {
          actionName: "XR_CLOSE_VIEW",
          responseText: `Closed ${XR_VIEW_ID}.`,
          parameters: { viewId: XR_VIEW_ID },
        }) ??
        (await expectControl(
          (control) =>
            control.type === "view_close" && control.viewId === XR_VIEW_ID,
          "view_close for the scenario XR view",
        )),
    },
    {
      kind: "message",
      name: "query XR vision",
      text: XR_QUERY_VISION_TEXT,
      responseIncludesAny: [XR_VISION_DESCRIPTION],
      assertTurn: (execution) =>
        expectAction(execution, {
          actionName: "XR_QUERY_VISION",
          responseText: XR_VISION_DESCRIPTION,
        }),
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "XR_LIST_VIEWS",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "XR_OPEN_VIEW",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "XR_SWITCH_VIEW",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "XR_RESIZE_VIEW",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "XR_CLOSE_VIEW",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "XR_QUERY_VISION",
      status: "success",
      minCount: 1,
    },
    {
      type: "selectedActionArguments",
      actionName: "XR_OPEN_VIEW",
      includesAll: [new RegExp(`"viewId":"${XR_VIEW_ID}"`)],
    },
    {
      type: "selectedActionArguments",
      actionName: "XR_RESIZE_VIEW",
      includesAll: [/"scale":1\.2/, /"distance":1\.1/],
    },
    {
      type: "custom",
      name: "XR service controls, route, and deterministic vision ledger are exact",
      predicate: finalLedgerCheck,
    },
    {
      type: "custom",
      name: "close scenario XR WebSocket client",
      predicate: cleanupXrClient,
    },
  ],
});
