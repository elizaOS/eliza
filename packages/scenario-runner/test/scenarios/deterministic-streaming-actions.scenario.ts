import {
  createServer,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Plugin } from "@elizaos/core";
import type {
  CapturedAction,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import streamingPlugin, {
  handleStreamRoute,
  streamStatusProvider,
  type StreamRouteState,
} from "../../../../plugins/plugin-streaming/src/index.ts";

const SCENARIO_ID = "deterministic-streaming-actions";
const STREAM_TEXT = {
  start: "Go live on Twitch",
  liveStatus: "Check Twitch stream status",
  stop: "Stop the Twitch stream",
  offlineStatus: "Check Twitch stream status after stop",
} as const;

type JsonRecord = Record<string, unknown>;

type RuntimeWithScenarioLlmFixtures = {
  actions?: Array<{ name?: unknown }>;
  plugins?: Array<{ name?: unknown }>;
  registerPlugin?: (plugin: Plugin) => Promise<void>;
  unregisterAction?: (name: string) => boolean;
};

type StreamRouteRequest = {
  method: string;
  pathname: string;
  response?: {
    body: unknown;
    status: number;
  };
  search: string;
};

const routeRequests: StreamRouteRequest[] = [];
const managerEvents: Array<{ type: string; config?: JsonRecord }> = [];
const destinationEvents: string[] = [];

let routeServer: Server | null = null;
let originalServerPort: string | undefined;
let originalStreamAudioSource: string | undefined;
let originalStreamMode: string | undefined;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function actionParameters(value: unknown): JsonRecord {
  const params = toRecord(value);
  return toRecord(params.parameters ?? params);
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

function normalizeStartConfig(config: unknown): JsonRecord {
  const record = toRecord(config);
  return {
    audioSource: record.audioSource,
    bitrate: record.bitrate,
    framerate: record.framerate,
    inputMode: record.inputMode,
    resolution: record.resolution,
    rtmpKey: record.rtmpKey,
    rtmpUrl: record.rtmpUrl,
    volume: record.volume,
  };
}

function createRouteState(): StreamRouteState {
  let running = false;
  let inputMode: string | null = null;
  let audioSource = "silent";
  let volume = 80;
  let muted = false;
  let frameCount = 0;

  return {
    activeDestinationId: "twitch",
    activeStreamSource: { type: "stream-tab" },
    destinations: new Map([
      [
        "twitch",
        {
          id: "twitch",
          name: "Twitch",
          async getCredentials() {
            destinationEvents.push("getCredentials");
            return {
              rtmpKey: "scenario-stream-key",
              rtmpUrl: "rtmp://127.0.0.1/live",
            };
          },
          async onStreamStart() {
            destinationEvents.push("onStreamStart");
          },
          async onStreamStop() {
            destinationEvents.push("onStreamStop");
          },
        },
      ],
    ]),
    streamManager: {
      getHealth() {
        return {
          audioSource,
          ffmpegAlive: running,
          frameCount,
          inputMode,
          muted,
          running,
          uptime: running ? 125 : 0,
          volume: muted ? 0 : volume,
        };
      },
      getVolume() {
        return muted ? 0 : volume;
      },
      isMuted() {
        return muted;
      },
      isRunning() {
        return running;
      },
      async mute() {
        muted = true;
      },
      async setVolume(level: number) {
        volume = Math.max(0, Math.min(100, Math.round(level)));
      },
      async start(config: unknown) {
        const normalized = normalizeStartConfig(config);
        managerEvents.push({ type: "start", config: normalized });
        audioSource =
          typeof normalized.audioSource === "string"
            ? normalized.audioSource
            : "silent";
        inputMode =
          typeof normalized.inputMode === "string"
            ? normalized.inputMode
            : null;
        frameCount = 0;
        running = true;
      },
      async stop() {
        managerEvents.push({ type: "stop" });
        running = false;
        inputMode = null;
        frameCount = 0;
        return { uptime: 125 };
      },
      async unmute() {
        muted = false;
      },
      writeFrame(_buf: Buffer) {
        if (!running) return false;
        frameCount += 1;
        return true;
      },
    },
  };
}

function parseResponseText(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function appendResponseChunk(chunks: Buffer[], chunk: unknown): void {
  if (chunk === undefined || chunk === null) return;
  if (Buffer.isBuffer(chunk)) {
    chunks.push(chunk);
    return;
  }
  if (chunk instanceof Uint8Array) {
    chunks.push(Buffer.from(chunk));
    return;
  }
  if (typeof chunk === "string") {
    chunks.push(Buffer.from(chunk));
  }
}

function captureResponse(
  res: ServerResponse,
  request: StreamRouteRequest,
): void {
  const chunks: Buffer[] = [];
  const response = res as ServerResponse & {
    end: (...args: unknown[]) => ServerResponse;
    write: (...args: unknown[]) => boolean;
  };
  const originalEnd = response.end.bind(res);
  const originalWrite = response.write.bind(res);

  response.write = (...args: unknown[]) => {
    appendResponseChunk(chunks, args[0]);
    return originalWrite(...args);
  };
  response.end = (...args: unknown[]) => {
    appendResponseChunk(chunks, args[0]);
    request.response = {
      body: parseResponseText(Buffer.concat(chunks).toString("utf8")),
      status: res.statusCode,
    };
    return originalEnd(...args);
  };
}

async function closeRouteServer(): Promise<void> {
  const server = routeServer;
  routeServer = null;
  if (!server) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function restoreStreamEnv(): void {
  if (originalServerPort === undefined) {
    delete process.env.SERVER_PORT;
  } else {
    process.env.SERVER_PORT = originalServerPort;
  }
  if (originalStreamAudioSource === undefined) {
    delete process.env.STREAM_AUDIO_SOURCE;
  } else {
    process.env.STREAM_AUDIO_SOURCE = originalStreamAudioSource;
  }
  if (originalStreamMode === undefined) {
    delete process.env.STREAM_MODE;
  } else {
    process.env.STREAM_MODE = originalStreamMode;
  }
}

async function startRouteServer(): Promise<number> {
  await closeRouteServer();
  const state = createRouteState();
  const server = createServer(async (req, res) => {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const request: StreamRouteRequest = {
      method,
      pathname: url.pathname,
      search: url.search,
    };
    routeRequests.push(request);
    captureResponse(res, request);

    try {
      const handled = await handleStreamRoute(
        req,
        res,
        url.pathname,
        method,
        state,
      );
      if (!handled && !res.writableEnded) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: `No stream route: ${url.pathname}` }));
      }
    } catch (err) {
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  });

  routeServer = server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("stream route server did not expose a TCP port");
  }
  return address.port;
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

function expectStreamAction(
  execution: ScenarioTurnExecution,
  expected: {
    parameters: JsonRecord;
    resultFields?: JsonRecord;
    text: string;
  },
): string | undefined {
  const action = firstAction(execution, "STREAM");
  if (typeof action === "string") return action;

  const params = actionParameters(action.parameters);
  for (const [key, expectedValue] of Object.entries(expected.parameters)) {
    const failure = expectEqual(params[key], expectedValue, `STREAM.${key}`);
    if (failure) return failure;
  }
  if (action.result?.success !== true) {
    return `expected STREAM result.success=true, saw ${stableStringify(action.result)}`;
  }
  if (action.result.text !== expected.text) {
    return `expected STREAM result.text=${JSON.stringify(expected.text)}, saw ${JSON.stringify(action.result.text)}`;
  }
  for (const [path, expectedValue] of Object.entries(
    expected.resultFields ?? {},
  )) {
    const failure = expectEqual(
      readPath(action.result, path),
      expectedValue,
      `STREAM result.${path}`,
    );
    if (failure) return failure;
  }
  return undefined;
}

function routeRequestSummary(): StreamRouteRequest[] {
  return routeRequests.map((request) => ({
    method: request.method,
    pathname: request.pathname,
    response: request.response
      ? {
          body: request.response.body,
          status: request.response.status,
        }
      : undefined,
    search: request.search,
  }));
}

async function finalStreamingCheck(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const failures: string[] = [];
  try {
    const providerResult = await streamStatusProvider.get(
      ctx.runtime as never,
      { content: { text: "stream status" } } as never,
      {} as never,
    );
    const providerRows = Array.isArray(
      toRecord(providerResult.data).stream_status,
    )
      ? (toRecord(providerResult.data).stream_status as unknown[]).filter(
          isRecord,
        )
      : [];
    if (providerRows.length !== 4) {
      failures.push(
        `expected streamStatus provider to return 4 platforms, saw ${providerRows.length}`,
      );
    }
    if (providerRows.some((row) => row.running !== false)) {
      failures.push(
        `expected streamStatus provider rows to be offline after stop, saw ${stableStringify(providerRows)}`,
      );
    }

    const expectedFirstRoutes: StreamRouteRequest[] = [
      {
        method: "POST",
        pathname: "/api/stream/live",
        response: {
          body: {
            audioSource: "silent",
            destination: "twitch",
            inputMode: "pipe",
            live: true,
            ok: true,
            rtmpUrl: "rtmp://127.0.0.1/live",
          },
          status: 200,
        },
        search: "",
      },
      {
        method: "GET",
        pathname: "/api/stream/status",
        response: {
          body: {
            audioSource: "silent",
            destination: { id: "twitch", name: "Twitch" },
            ffmpegAlive: true,
            frameCount: 0,
            inputMode: "pipe",
            muted: false,
            ok: true,
            running: true,
            uptime: 125,
            volume: 80,
          },
          status: 200,
        },
        search: "",
      },
      {
        method: "POST",
        pathname: "/api/stream/offline",
        response: { body: { live: false, ok: true }, status: 200 },
        search: "",
      },
      {
        method: "GET",
        pathname: "/api/stream/status",
        response: {
          body: {
            audioSource: "silent",
            destination: { id: "twitch", name: "Twitch" },
            ffmpegAlive: false,
            frameCount: 0,
            inputMode: null,
            muted: false,
            ok: true,
            running: false,
            uptime: 0,
            volume: 80,
          },
          status: 200,
        },
        search: "",
      },
    ];
    const actualRoutes = routeRequestSummary();
    const firstRouteFailure = expectEqual(
      actualRoutes.slice(0, 4),
      expectedFirstRoutes,
      "STREAM route ledger",
    );
    if (firstRouteFailure) failures.push(firstRouteFailure);

    const providerStatusRoutes = actualRoutes.slice(4);
    if (
      providerStatusRoutes.length !== 4 ||
      providerStatusRoutes.some(
        (request) =>
          request.method !== "GET" ||
          request.pathname !== "/api/stream/status" ||
          request.response?.status !== 200,
      )
    ) {
      failures.push(
        `expected provider to hit four status routes after action turns, saw ${stableStringify(providerStatusRoutes)}`,
      );
    }

    const managerFailure = expectEqual(
      managerEvents,
      [
        {
          config: {
            audioSource: "silent",
            bitrate: "1500k",
            framerate: 15,
            inputMode: "pipe",
            resolution: "1280x720",
            rtmpKey: "scenario-stream-key",
            rtmpUrl: "rtmp://127.0.0.1/live",
            volume: 80,
          },
          type: "start",
        },
        { type: "stop" },
      ],
      "stream manager side effects",
    );
    if (managerFailure) failures.push(managerFailure);

    const destinationFailure = expectEqual(
      destinationEvents,
      ["getCredentials", "onStreamStart", "onStreamStop"],
      "stream destination lifecycle",
    );
    if (destinationFailure) failures.push(destinationFailure);

    return failures.length > 0 ? failures.join("\n") : undefined;
  } finally {
    await closeRouteServer();
    restoreStreamEnv();
  }
}

export default scenario({
  id: "deterministic-streaming-actions",
  title: "Deterministic STREAM action and route coverage",
  domain: "streaming",
  tags: ["pr", "deterministic", "zero-cost", "streaming"],
  isolation: "shared-runtime",
  requires: {
    plugins: ["@elizaos/plugin-streaming"],
  },
  seed: [
    {
      type: "custom",
      name: "register streaming plugin, strict LLM fixtures, and loopback stream routes",
      apply: async (ctx) => {
        routeRequests.length = 0;
        managerEvents.length = 0;
        destinationEvents.length = 0;
        originalServerPort = process.env.SERVER_PORT;
        originalStreamAudioSource = process.env.STREAM_AUDIO_SOURCE;
        originalStreamMode = process.env.STREAM_MODE;
        process.env.STREAM_AUDIO_SOURCE = "silent";
        process.env.STREAM_MODE = "pipe";

        const port = await startRouteServer();
        process.env.SERVER_PORT = String(port);

        const runtime = ctx.runtime as RuntimeWithScenarioLlmFixtures;
        if (!runtime.registerPlugin) return "runtime.registerPlugin unavailable";
        if (
          !runtime.plugins?.some((plugin) => plugin.name === streamingPlugin.name)
        ) {
          runtime.unregisterAction?.("STREAM");
          await runtime.registerPlugin(streamingPlugin);
        }

        return undefined;
      },
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Deterministic Streaming",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "STREAM starts Twitch stream through loopback route",
      text: STREAM_TEXT.start,
      actionName: "STREAM",
      options: { action: "start", platform: "twitch" },
      responseIncludesAny: ["Twitch stream started successfully"],
      assertTurn: (execution) =>
        expectStreamAction(execution, {
          parameters: { action: "start", platform: "twitch" },
          text: "Twitch stream started successfully! We're live.",
        }),
    },
    {
      kind: "action",
      name: "STREAM reads live Twitch status through loopback route",
      text: STREAM_TEXT.liveStatus,
      actionName: "STREAM",
      options: { action: "status", platform: "twitch" },
      responseIncludesAny: ["Twitch stream status: LIVE", "Uptime: 2m"],
      assertTurn: (execution) =>
        expectStreamAction(execution, {
          parameters: { action: "status", platform: "twitch" },
          resultFields: {
            "data.snapshot.destination": "Twitch",
            "data.snapshot.frames": null,
            "data.snapshot.platform": "twitch",
            "data.snapshot.running": true,
            "data.snapshot.uptimeSeconds": 125,
          },
          text: "Twitch stream status: LIVE | Uptime: 2m | Destination: Twitch",
        }),
    },
    {
      kind: "action",
      name: "STREAM stops Twitch stream through loopback route",
      text: STREAM_TEXT.stop,
      actionName: "STREAM",
      options: { action: "stop", platform: "twitch" },
      responseIncludesAny: ["Twitch stream stopped"],
      assertTurn: (execution) =>
        expectStreamAction(execution, {
          parameters: { action: "stop", platform: "twitch" },
          text: "Twitch stream stopped. We're offline now.",
        }),
    },
    {
      kind: "action",
      name: "STREAM reads offline Twitch status through loopback route",
      text: STREAM_TEXT.offlineStatus,
      actionName: "STREAM",
      options: { action: "status", platform: "twitch" },
      responseIncludesAny: ["Twitch stream status: OFFLINE", "Uptime: 0m"],
      assertTurn: (execution) =>
        expectStreamAction(execution, {
          parameters: { action: "status", platform: "twitch" },
          resultFields: {
            "data.snapshot.destination": "Twitch",
            "data.snapshot.frames": null,
            "data.snapshot.platform": "twitch",
            "data.snapshot.running": false,
            "data.snapshot.uptimeSeconds": 0,
          },
          text: "Twitch stream status: OFFLINE | Uptime: 0m | Destination: Twitch",
        }),
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "STREAM",
      status: "success",
      minCount: 4,
    },
    {
      type: "selectedActionArguments",
      actionName: "STREAM",
      includesAll: [/twitch/, /start/, /status/, /stop/],
    },
    {
      type: "custom",
      name: "real STREAM action hit stream routes and deterministic state exactly",
      predicate: finalStreamingCheck,
    },
  ],
});
