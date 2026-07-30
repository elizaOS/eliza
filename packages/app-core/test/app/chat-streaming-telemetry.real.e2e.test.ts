/**
 * Real chat delivery telemetry through a PGLite runtime, the production HTTP
 * route and SSE parser, `useChatSend`, and the memoized React transcript.
 *
 * Stage-1 provider output streams into the runtime, but its structured envelope
 * is held until routing and side-effect validation finish. The browser therefore
 * receives one validated reply rather than unsafe partial `replyText`.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import {
  buildInferenceTimingDevPayload,
  inferenceTimingRegistry,
  type ModelRegistrationMetadata,
  ModelType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/core/testing";
import { type Browser, chromium, type Page } from "playwright-core";
import { build as viteBuild } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type {
  ConversationRouteContext,
  ConversationRouteState,
} from "../../../agent/src/api/conversation-routes.ts";
import { handleConversationRoutes } from "../../../agent/src/api/conversation-routes.ts";
import {
  generateNodeBuiltinStub,
  nativeModuleStubPlugin,
} from "../../../app/vite/native-module-stub-plugin.ts";

const CHROME_PATH =
  process.env.ELIZA_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHROME_AVAILABLE = existsSync(CHROME_PATH);
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const HARNESS_ENTRY = path.join(
  REPO_ROOT,
  "packages/app-core/test/fixtures/chat-streaming-telemetry-harness.tsx",
);
const TOKEN_DELAY_MS = Number(process.env.MOCK_LLM_TOKEN_DELAY_MS ?? 25);
const REPLY_TOKENS = ["Fast ", "streaming ", "stays ", "smooth."];
const REPLY_TEXT = REPLY_TOKENS.join("");
const requireFromTest = createRequire(import.meta.url);
const browserPolyfilledBuiltins = new Set([
  "buffer",
  "process",
  "stream",
  "util",
]);
const nodeBuiltins = new Set(
  builtinModules.map((moduleId) => moduleId.replace(/^node:/, "")),
);
const telemetryNow = (): number => performance.timeOrigin + performance.now();

function resolveNodeBuiltin(
  source: string,
  virtualPrefix: string,
): string | null {
  const bareSource = source.replace(/^node:/, "");
  const rootModule = bareSource.split("/")[0];
  if (browserPolyfilledBuiltins.has(rootModule)) return null;
  if (!source.startsWith("node:") && !nodeBuiltins.has(bareSource)) return null;
  return `${virtualPrefix}node:${bareSource}`;
}

interface ProviderChunk {
  at: number;
  chunk: string;
  kind: "prefix" | "visible" | "suffix";
}

interface ServerFrame {
  at: number;
  value: Record<string, unknown>;
}

interface BrowserTelemetry {
  commits: Array<{ actualDuration: number; at: number; phase: string }>;
  doneAt?: number;
  error?: string;
  historyReloads: number;
  mountCounts: Record<string, number>;
  mutations: Array<{ at: number; value: string }>;
  rafCallbacks: number[];
  rafScheduled: number[];
  readyAt?: number;
  renderCounts: Record<string, number>;
  sseFrames: Array<{ at: number; value: Record<string, unknown> }>;
  startedAt?: number;
  stateSnapshots: Array<{
    at: number;
    value: Array<{
      clientRenderId?: string;
      id: string;
      role: string;
      text: string;
    }>;
  }>;
  unmountCounts: Record<string, number>;
}

interface HarnessState {
  api: Server;
  apiBase: string;
  browser: Browser;
  cleanupRuntime: () => Promise<void>;
  harnessServer: Server;
  harnessUrl: string;
  page: Page;
  providerChunks: ProviderChunk[];
  runtime: Awaited<ReturnType<typeof createTestRuntime>>["runtime"];
  serverFrames: ServerFrame[];
  wsMessages: Array<Record<string, unknown>>;
}

async function startConversationServer(
  state: ConversationRouteState,
  allowedOrigin: string,
  serverFrames: ServerFrame[],
): Promise<{
  server: Server;
  port: number;
  wsMessages: Array<Record<string, unknown>>;
}> {
  const wsMessages: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const nativeWrite = response.write.bind(response);
    response.write = ((chunk: Parameters<typeof nativeWrite>[0], ...args) => {
      const text = Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : String(chunk);
      for (const match of text.matchAll(/^data: (.+)$/gm)) {
        try {
          serverFrames.push({
            at: telemetryNow(),
            value: JSON.parse(match[1] as string) as Record<string, unknown>,
          });
        } catch {
          // Non-JSON SSE data is outside the chat frame contract.
        }
      }
      return nativeWrite(chunk, ...args);
    }) as typeof response.write;
    response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    response.setHeader(
      "Access-Control-Allow-Headers",
      "content-type,x-elizaos-client-id,x-elizaos-ui-language",
    );
    response.setHeader(
      "Access-Control-Allow-Methods",
      "DELETE,GET,PATCH,POST,OPTIONS",
    );
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const context = {
      req: request,
      res: response,
      method: request.method ?? "GET",
      pathname: requestUrl.pathname,
      state,
      readJsonBody: async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks).toString("utf8");
        return body ? JSON.parse(body) : {};
      },
      json: (res: ServerResponse, value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      },
      error: (res: ServerResponse, message: string, status = 500) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      },
    } as unknown as ConversationRouteContext;
    const handled = await handleConversationRoutes(context);
    if (!handled && !response.writableEnded) {
      context.error(response, "Not found", 404);
    }
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      client.on("message", (data) => {
        const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
        wsMessages.push(parsed);
      });
      wss.emit("connection", client, request);
    });
  });
  server.on("close", () => {
    for (const client of wss.clients) client.close();
    wss.close();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("conversation server did not bind a TCP port");
  }
  return { server, port: address.port, wsMessages };
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(value));
}

async function listenHarness(): Promise<{
  server: Server;
  port: number;
  setBundle: (value: string) => void;
  setApiBase: (value: string) => void;
}> {
  let bundle = "";
  let apiBase = "";
  const server = createServer((request, response) => {
    if (request.url === "/bundle.js") {
      response.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
      });
      response.end(bundle);
      return;
    }
    if (request.url === "/health") {
      writeJson(response, 200, { ok: true });
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html>
        <head><meta charset="utf-8"><title>chat telemetry</title></head>
        <body>
          <div id="root"></div>
          <script>
            window.global=window;
            window.process={
              argv:[],
              browser:true,
              cwd:()=>"/",
              emit:()=>false,
              env:{NODE_DEBUG:""},
              execArgv:[],
              nextTick:(callback,...args)=>queueMicrotask(()=>callback(...args)),
              off(){return this},
              on(){return this},
              once(){return this},
              platform:"browser",
              version:"v24.0.0",
              versions:{}
            };
            window.__API_BASE__=${JSON.stringify(apiBase)};
          </script>
          <script src="/bundle.js"></script>
        </body>
      </html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("harness did not bind a TCP port");
  }
  return {
    server,
    port: address.port,
    setBundle: (value) => {
      bundle = value;
    },
    setApiBase: (value) => {
      apiBase = value;
    },
  };
}

function buildStructuredReply(): {
  prefix: string;
  suffix: string;
  raw: string;
} {
  const prefix =
    '{"shouldRespond":"RESPOND","contexts":["simple"],"intents":[],"replyText":"';
  const suffix =
    '","candidateActionNames":[],"facts":[],"relationships":[],"addressedTo":[],"topics":[],"emotion":""}';
  return { prefix, suffix, raw: `${prefix}${REPLY_TEXT}${suffix}` };
}

function reconstructSseText(frames: BrowserTelemetry["sseFrames"]): string {
  let text = "";
  for (const { value } of frames) {
    if (value.type !== "token") continue;
    if (typeof value.fullText === "string") {
      text = value.fullText;
    } else if (typeof value.text === "string") {
      text += value.text;
    }
  }
  return text;
}

function elapsedSeries(values: number[], base: number): number[] {
  return values.map((value) => Number((value - base).toFixed(2)));
}

const suite = CHROME_AVAILABLE ? describe : describe.skip;
let state: HarnessState | null = null;

suite("chat delivery telemetry real e2e", () => {
  beforeAll(async () => {
    inferenceTimingRegistry.reset();
    const harness = await listenHarness();

    const runtimeResult = await createTestRuntime({
      characterName: "Telemetry Agent",
    });
    const providerChunks: ProviderChunk[] = [];
    const { prefix, suffix, raw } = buildStructuredReply();
    runtimeResult.runtime.registerModel(
      ModelType.RESPONSE_HANDLER,
      async () => ({
        textStream: (async function* () {
          providerChunks.push({
            at: telemetryNow(),
            chunk: prefix,
            kind: "prefix",
          });
          yield prefix;
          for (const token of REPLY_TOKENS) {
            if (TOKEN_DELAY_MS > 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, TOKEN_DELAY_MS),
              );
            }
            providerChunks.push({
              at: telemetryNow(),
              chunk: token,
              kind: "visible",
            });
            yield token;
          }
          providerChunks.push({
            at: telemetryNow(),
            chunk: suffix,
            kind: "suffix",
          });
          yield suffix;
        })(),
        text: Promise.resolve(raw),
        usage: Promise.resolve({
          inputTokens: 1,
          outputTokens: REPLY_TOKENS.length,
          totalTokens: 1 + REPLY_TOKENS.length,
        }),
        finishReason: Promise.resolve("stop"),
      }),
      "telemetry-mock",
      10_000,
      { streamable: true } satisfies ModelRegistrationMetadata,
    );

    const adminEntityId = stringToUuid("chat-telemetry-admin");
    const serverFrames: ServerFrame[] = [];
    const routeState: ConversationRouteState = {
      runtime: runtimeResult.runtime,
      config: { user: { name: "Telemetry User" } } as never,
      agentName: runtimeResult.runtime.character.name ?? "Telemetry Agent",
      adminEntityId,
      chatUserId: adminEntityId,
      logBuffer: [],
      conversations: new Map(),
      activeChatTurnCount: 0,
      conversationRestorePromise: null,
      deletedConversationIds: new Set(),
      broadcastWs: null,
    };
    const api = await startConversationServer(
      routeState,
      `http://127.0.0.1:${harness.port}`,
      serverFrames,
    );
    const apiBase = `http://127.0.0.1:${api.port}`;
    harness.setApiBase(apiBase);

    const cachedBundlePath =
      process.env.ELIZA_CHAT_TELEMETRY_BUNDLE_PATH?.trim();
    const cachedBundle =
      cachedBundlePath && existsSync(cachedBundlePath)
        ? await readFile(cachedBundlePath, "utf8")
        : null;
    const built = cachedBundle
      ? null
      : await viteBuild({
          configFile: false,
          define: {
            "process.env": "{}",
            "process.platform": JSON.stringify("browser"),
          },
          logLevel: "silent",
          plugins: [
            nativeModuleStubPlugin({
              isCapacitorMobileBuild: false,
              requireModule: requireFromTest,
            }),
            {
              name: "chat-telemetry-node-stubs",
              enforce: "pre",
              resolveId(source) {
                return resolveNodeBuiltin(
                  source,
                  "\0chat-telemetry-node-stub:",
                );
              },
              load(id) {
                const prefix = "\0chat-telemetry-node-stub:";
                return id.startsWith(prefix)
                  ? generateNodeBuiltinStub(
                      id.slice(prefix.length),
                      requireFromTest,
                    )
                  : null;
              },
            },
          ],
          resolve: {
            alias: [
              {
                find: /^node:buffer$/,
                replacement: path.join(
                  REPO_ROOT,
                  "packages/ui/test/stubs/node-buffer.ts",
                ),
              },
              { find: /^node:process$/, replacement: "process/browser" },
              {
                find: /^node:util$/,
                replacement: path.join(
                  REPO_ROOT,
                  "packages/ui/test/stubs/node-util.ts",
                ),
              },
              {
                find: /^util$/,
                replacement: path.join(
                  REPO_ROOT,
                  "packages/ui/test/stubs/node-util.ts",
                ),
              },
              {
                find: /^stream$/,
                replacement: path.join(
                  REPO_ROOT,
                  "node_modules/.bun/stream-browserify@3.0.0/node_modules/stream-browserify/index.js",
                ),
              },
            ],
          },
          build: {
            lib: {
              entry: HARNESS_ENTRY,
              formats: ["iife"],
              name: "ChatTelemetryHarness",
            },
            rolldownOptions: {
              plugins: [
                {
                  name: "chat-telemetry-node-stubs-build",
                  resolveId(source) {
                    return resolveNodeBuiltin(
                      source,
                      "\0chat-telemetry-build-node-stub:",
                    );
                  },
                  load(id) {
                    const prefix = "\0chat-telemetry-build-node-stub:";
                    return id.startsWith(prefix)
                      ? generateNodeBuiltinStub(
                          id.slice(prefix.length),
                          requireFromTest,
                        )
                      : null;
                  },
                },
              ],
            },
            target: "chrome120",
            minify: false,
            write: false,
          },
        });
    const buildOutput = Array.isArray(built) ? built[0] : built;
    const bundle =
      cachedBundle ??
      buildOutput?.output.find((output) => output.type === "chunk")?.code;
    if (!bundle) throw new Error("chat telemetry harness bundle was empty");
    if (cachedBundlePath && !cachedBundle) {
      await writeFile(cachedBundlePath, bundle);
    }
    harness.setBundle(bundle);

    const browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ["--use-angle=swiftshader"],
    });
    const videoPath = process.env.ELIZA_CHAT_TELEMETRY_VIDEO?.trim();
    const page = await browser.newPage({
      viewport: { height: 800, width: 1280 },
      ...(videoPath
        ? {
            recordVideo: {
              dir: path.dirname(videoPath),
              size: { height: 800, width: 1280 },
            },
          }
        : {}),
    });
    page.on("console", (message) => {
      process.stdout.write(
        `[chat-telemetry][browser:${message.type()}] ${message.text()}\n`,
      );
    });
    page.on("pageerror", (error) => {
      process.stdout.write(`[chat-telemetry][pageerror] ${error.stack}\n`);
    });
    page.on("requestfailed", (request) => {
      process.stdout.write(
        `[chat-telemetry][requestfailed] ${request.url()} ${request.failure()?.errorText}\n`,
      );
    });
    await page.goto(`http://127.0.0.1:${harness.port}/`);

    state = {
      api: api.server,
      apiBase,
      browser,
      cleanupRuntime: runtimeResult.cleanup,
      harnessServer: harness.server,
      harnessUrl: `http://127.0.0.1:${harness.port}/`,
      page,
      providerChunks,
      runtime: runtimeResult.runtime,
      serverFrames,
      wsMessages: api.wsMessages,
    };
    await page.waitForFunction(
      () =>
        window.__chatTelemetry?.readyAt != null ||
        window.__chatTelemetry?.error != null,
    );
    const startupTelemetry = await page.evaluate(() => window.__chatTelemetry);
    if (startupTelemetry.error) {
      throw new Error(
        `browser harness startup failed: ${startupTelemetry.error}`,
      );
    }
  }, 180_000);

  afterAll(async () => {
    if (!state) return;
    const videoPath = process.env.ELIZA_CHAT_TELEMETRY_VIDEO?.trim();
    const video = state.page.video();
    await state.page.close();
    if (videoPath && video) {
      await video.saveAs(videoPath);
    }
    await state.browser.close();
    await new Promise<void>((resolve) => state?.api.close(() => resolve()));
    await state.cleanupRuntime();
    await new Promise<void>((resolve) =>
      state?.harnessServer.close(() => resolve()),
    );
    state = null;
  }, 180_000);

  it("proves streamed provider output is validated before SSE → React state → PGLite → pixels", async () => {
    if (!state) throw new Error("harness not initialized");
    if (process.env.ELIZA_CHAT_TELEMETRY_BEFORE_SCREENSHOT) {
      await state.page.screenshot({
        fullPage: true,
        path: process.env.ELIZA_CHAT_TELEMETRY_BEFORE_SCREENSHOT,
      });
    }
    await state.page.evaluate(async () => {
      await window.__startChat("Give the deterministic telemetry reply.");
    });
    await state.page.waitForFunction(
      () => window.__chatTelemetry.doneAt != null,
    );

    const browserTelemetry = await state.page.evaluate<BrowserTelemetry>(
      () => window.__chatTelemetry,
    );
    const conversationResponse = await fetch(
      `${state.apiBase}/api/conversations`,
    );
    const conversationJson = (await conversationResponse.json()) as {
      conversations: Array<{ id: string; roomId: UUID }>;
    };
    const conversation = conversationJson.conversations.find(
      (candidate) => candidate.id,
    );
    if (!conversation) throw new Error("telemetry conversation not found");
    const dbMessages = await state.runtime.getMemories({
      roomId: conversation.roomId,
      tableName: "messages",
      limit: 20,
    });
    const assistantDbMessage = dbMessages.find(
      (message) => message.entityId === state?.runtime.agentId,
    );
    const userDbMessage = dbMessages.find(
      (message) => message.entityId !== state?.runtime.agentId,
    );
    const doneFrame = browserTelemetry.sseFrames.find(
      ({ value }) => value.type === "done",
    )?.value;
    const finalSnapshot = browserTelemetry.stateSnapshots.at(-1)?.value ?? [];
    const assistantStateMessage = finalSnapshot.find(
      (message) => message.role === "assistant",
    );
    const finalDom = (
      await state.page.locator("#transcript").innerText()
    ).trim();
    const sseText = reconstructSseText(browserTelemetry.sseFrames);

    expect(browserTelemetry.error).toBeUndefined();
    expect(
      state.providerChunks
        .filter((chunk) => chunk.kind === "visible")
        .map((chunk) => chunk.chunk),
    ).toEqual(REPLY_TOKENS);
    expect(sseText).toBe(REPLY_TEXT);
    expect(doneFrame?.fullText).toBe(REPLY_TEXT);
    expect(assistantStateMessage?.text).toBe(REPLY_TEXT);
    expect(assistantDbMessage?.content.text).toBe(REPLY_TEXT);
    expect(finalDom).toContain(REPLY_TEXT);
    expect(doneFrame?.messageId).toBe(assistantDbMessage?.id);
    expect(doneFrame?.userMessageId).toBe(userDbMessage?.id);
    expect(browserTelemetry.historyReloads).toBe(0);
    expect(browserTelemetry.rafScheduled).toEqual([]);
    expect(browserTelemetry.rafCallbacks).toEqual([]);
    await expect.poll(() => state?.wsMessages.length ?? 0).toBeGreaterThan(0);
    expect(state.wsMessages).toContainEqual(
      expect.objectContaining({
        type: "active-conversation",
        conversationId: conversation.id,
      }),
    );

    const assistantStates = browserTelemetry.stateSnapshots
      .map(
        ({ value }) =>
          value.find((message) => message.role === "assistant")?.text ?? "",
      )
      .filter((text, index, values) => text && text !== values[index - 1]);
    expect(assistantStates).toEqual([REPLY_TEXT]);
    const assistantMutations = browserTelemetry.mutations.filter(({ value }) =>
      value.includes(REPLY_TEXT),
    );
    expect(assistantMutations).toHaveLength(1);
    expect(assistantMutations[0]?.value).toContain(REPLY_TEXT);
    expect(
      browserTelemetry.sseFrames
        .filter(({ value }) => value.type === "token")
        .map(({ value }) => value.text),
    ).toEqual([REPLY_TEXT]);

    const finalUserState = finalSnapshot.find(
      (message) => message.role === "user",
    );
    expect(finalUserState?.clientRenderId).toMatch(/^temp-/);
    expect(assistantStateMessage?.clientRenderId).toMatch(/^temp-resp-/);
    for (const message of [finalUserState, assistantStateMessage]) {
      const renderKey = message?.clientRenderId;
      expect(renderKey).toBeTruthy();
      if (!renderKey) continue;
      expect(browserTelemetry.mountCounts[renderKey]).toBe(1);
      expect(browserTelemetry.unmountCounts[renderKey] ?? 0).toBe(0);
    }

    const startedAt = browserTelemetry.startedAt ?? 0;
    const inferenceTelemetry = buildInferenceTimingDevPayload(10);
    const chatTurn = inferenceTelemetry.turns.find(
      (turn) => turn.label === "chat-request",
    );
    const chatFlow = inferenceTelemetry.flows.find(
      (flow) => flow.turnId === chatTurn?.turnId,
    );
    expect(chatTurn).toBeDefined();
    expect(chatFlow).toBeDefined();
    expect(chatTurn?.byName["evaluators:injection-risk-gate"]?.count).toBe(1);
    const report = {
      tokenDelayConfiguredMs: TOKEN_DELAY_MS,
      provider: {
        chunks: state.providerChunks.map((chunk) => ({
          ...chunk,
          elapsedMs: Number((chunk.at - startedAt).toFixed(2)),
        })),
      },
      sse: {
        serverFrames: state.serverFrames.map((frame) => ({
          elapsedMs: Number((frame.at - startedAt).toFixed(2)),
          value: frame.value,
        })),
        frames: browserTelemetry.sseFrames.map((frame) => ({
          elapsedMs: Number((frame.at - startedAt).toFixed(2)),
          value: frame.value,
        })),
      },
      react: {
        commitCount: browserTelemetry.commits.length,
        commits: browserTelemetry.commits.map((commit) => ({
          ...commit,
          elapsedMs: Number((commit.at - startedAt).toFixed(2)),
        })),
        renderCounts: browserTelemetry.renderCounts,
        mountCounts: browserTelemetry.mountCounts,
        unmountCounts: browserTelemetry.unmountCounts,
        stateSnapshotCount: browserTelemetry.stateSnapshots.length,
        historyReloads: browserTelemetry.historyReloads,
      },
      browser: {
        mutations: browserTelemetry.mutations.map((mutation) => ({
          elapsedMs: Number((mutation.at - startedAt).toFixed(2)),
          value: mutation.value,
        })),
        rafScheduledMs: elapsedSeries(browserTelemetry.rafScheduled, startedAt),
        rafCallbackMs: elapsedSeries(browserTelemetry.rafCallbacks, startedAt),
        finalDom,
      },
      db: dbMessages.map((message) => ({
        id: message.id,
        entityId: message.entityId,
        text: message.content.text,
      })),
      websocket: {
        messages: state.wsMessages,
      },
      inference: {
        turn: chatTurn,
        flow: chatFlow,
        derivedHistograms: inferenceTelemetry.derivedHistograms,
      },
      equality: {
        provider: REPLY_TEXT,
        sse: sseText,
        done: doneFrame?.fullText,
        state: assistantStateMessage?.text,
        database: assistantDbMessage?.content.text,
        domContainsReply: finalDom.includes(REPLY_TEXT),
      },
    };
    process.stdout.write(
      `[chat-telemetry][report] ${JSON.stringify(report)}\n`,
    );
    if (process.env.ELIZA_CHAT_TELEMETRY_DUMP) {
      await writeFile(
        process.env.ELIZA_CHAT_TELEMETRY_DUMP,
        JSON.stringify(report, null, 2),
      );
    }
    if (process.env.ELIZA_CHAT_TELEMETRY_SCREENSHOT) {
      await state.page.screenshot({
        fullPage: true,
        path: process.env.ELIZA_CHAT_TELEMETRY_SCREENSHOT,
      });
    }
  }, 180_000);
});
