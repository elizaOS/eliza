// spec/embeddings/index.md, "Story: Embed every input in the configured vector space"
import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import {
  ConfidentialInferenceAuthority,
  ModelType,
  runWithConfidentialInference,
  type IAgentRuntime,
} from "@elizaos/core";
import type { Driver, Options } from "../../gen/embeddings.conformance.ts";
import type { EmbeddingAttempt, EmbeddingRun, Event, VectorObservation } from "../../gen/embeddings.ts";
import { handleBatchTextEmbedding, handleTextEmbedding } from "../../src/index.vibe";

type GateAction =
  | { readonly kind: "respond"; readonly status: number; readonly body: unknown }
  | { readonly kind: "confidential-deny" }
  | { readonly kind: "abort" };

interface PausedAttempt {
  readonly attempt: EmbeddingAttempt;
  readonly action: PromiseWithResolvers<GateAction>;
  readonly settled: Promise<void>;
}

interface EntitySlot {
  state: EmbeddingRun;
  controller: AbortController | undefined;
  pendingRun: Promise<number[][]> | undefined;
  paused: PausedAttempt | undefined;
  nextPaused: PromiseWithResolvers<PausedAttempt> | undefined;
  confidentialDeny: PromiseWithResolvers<never> | undefined;
}

const VALID_WIDTHS = new Set([384, 512, 768, 1024, 1536, 2048, 3072]);

let server: Server | undefined;
let baseUrl = "";
let runEpoch = 0;
const slots = new Map<string, EntitySlot>();
let probeResponseBody: unknown;

function initialRun(): EmbeddingRun {
  return { phase: "Awaiting", attempt: "PrimaryAttempt", count: 0, width: 0, hasFallback: false };
}

function slotOf(key: string): EntitySlot {
  let slot = slots.get(key);
  if (!slot) {
    slot = {
      state: initialRun(),
      controller: undefined,
      pendingRun: undefined,
      paused: undefined,
      nextPaused: undefined,
      confidentialDeny: undefined,
    };
    slots.set(key, slot);
  }
  return slot;
}

function makeRuntime(settings: Record<string, string>): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    getSetting: (key: string) => (Object.hasOwn(settings, key) ? settings[key] : null),
    emitEvent: () => Promise.resolve(),
    reportError: () => undefined,
  } as unknown as IAgentRuntime;
}

function rowsToWire(rows: readonly VectorObservation[]): { data: Array<{ index: number; embedding: Array<number | null> }> } {
  return {
    data: rows.map((row) => ({
      index: row.inputIndex,
      embedding: Array.from({ length: Math.max(0, row.vectorWidth) }, (_item, index) =>
        index === 0 ? (row.finiteCoordinates ? 1 : null) : 0,
      ),
    })),
  };
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify(body));
}

function closeAborted(res: ServerResponse): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(499, { connection: "close" });
  res.end();
}

async function ensureServer(): Promise<string> {
  if (server) return baseUrl;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    req.on("end", () => {
      const url = req.url ?? "";
      if (url === "/probe/embeddings") {
        writeJson(res, 200, probeResponseBody);
        return;
      }
      const match = /^\/epoch\/(\d+)\/entity\/([^/]+)\/(primary|fallback)\/embeddings$/.exec(url);
      if (!match || Number(match[1]) !== runEpoch) {
        writeJson(res, 404, { error: "unknown route" });
        return;
      }
      const key = decodeURIComponent(match[2] ?? "");
      const attempt: EmbeddingAttempt = match[3] === "fallback" ? "FallbackAttempt" : "PrimaryAttempt";
      const slot = slotOf(key);
      const action = Promise.withResolvers<GateAction>();
      const settled = Promise.withResolvers<void>();
      const paused: PausedAttempt = { attempt, action, settled: settled.promise };
      slot.paused = paused;
      const waiter = slot.nextPaused;
      slot.nextPaused = undefined;
      waiter?.resolve(paused);
      void action.promise.then((decision) => {
        if (decision.kind === "respond") {
          writeJson(res, decision.status, decision.body);
        } else {
          closeAborted(res);
        }
        settled.resolve();
      });
    });
  });
  server.keepAliveTimeout = 0;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  return baseUrl;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ABORT_ERR";
}

function abortSlot(slot: EntitySlot): void {
  slot.controller?.abort(new Error("reset"));
  slot.paused?.action.resolve({ kind: "abort" });
  slot.paused = undefined;
  slot.nextPaused = undefined;
  slot.confidentialDeny = undefined;
  slot.controller = undefined;
  slot.pendingRun = undefined;
}

async function probeRowsRejected(width: number, count: number, rows: readonly VectorObservation[]): Promise<boolean> {
  const root = await ensureServer();
  probeResponseBody = rowsToWire(rows);
  const runtime = makeRuntime({
    EMBEDDING_BASE_URL: `${root}/probe`,
    EMBEDDING_DIMENSIONS: String(width),
    EMBEDDING_FALLBACK_BASE_URL: "",
  });
  const texts = Array.from({ length: count }, (_item, index) => `probe-${index}`);
  try {
    await handleBatchTextEmbedding(runtime, texts);
    return false;
  } catch {
    return true;
  }
}

export const driver: Driver & AsyncDisposable = {
  async reset() {
    runEpoch += 1;
    for (const slot of slots.values()) {
      const pending = slot.pendingRun;
      abortSlot(slot);
      if (pending) await pending.catch(() => undefined);
    }
    slots.clear();
    await ensureServer();
  },

  async dispatch(key: string, event: Event) {
    const slot = slotOf(key);
    const root = await ensureServer();

    if (event.type === "beginEmbedding") {
      if (slot.state.phase !== "Awaiting" || slot.state.count > 0) return "refused";
      const encodedKey = encodeURIComponent(key);
      const primaryBase = `${root}/epoch/${runEpoch}/entity/${encodedKey}/primary`;
      const fallbackBase = event.hasFallback ? `${root}/epoch/${runEpoch}/entity/${encodedKey}/fallback` : "";
      const runtime = makeRuntime({
        EMBEDDING_BASE_URL: primaryBase,
        EMBEDDING_DIMENSIONS: String(event.width),
        EMBEDDING_FALLBACK_BASE_URL: fallbackBase,
      });
      if (event.inputCount <= 0 || !VALID_WIDTHS.has(event.width)) {
        try {
          await handleTextEmbedding(runtime, event.inputCount <= 0 ? "" : "x");
          throw new Error("expected invalid beginEmbedding input to fail");
        } catch {
          return "refused";
        }
      }
      const controller = new AbortController();
      const firstPaused = Promise.withResolvers<PausedAttempt>();
      const confidentialDeny = Promise.withResolvers<never>();
      void confidentialDeny.promise.catch(() => undefined);
      slot.controller = controller;
      slot.nextPaused = firstPaused;
      slot.confidentialDeny = confidentialDeny;

      const profile = {
        revision: "conformance",
        expiresAt: Date.now() + 60_000,
        routes: [primaryBase, ...(fallbackBase ? [fallbackBase] : [])].map((url, index) => ({
          id: `route-${index}`,
          endpoint: `${url}/embeddings`,
          model: "text-embedding-3-small",
          modelTypes: [ModelType.TEXT_EMBEDDING, ModelType.TEXT_EMBEDDING_BATCH],
        })),
      };
      const authority = new ConfidentialInferenceAuthority({
        handlers: [handleBatchTextEmbedding, handleTextEmbedding],
        currentProfile: () => profile,
        audit: { append: () => Promise.resolve() },
        transport: async (url, init, context) => {
          await context.beforeDispatch({
            evidenceDigest: "a".repeat(64),
            connectionBindingDigest: "b".repeat(64),
          });
          return Promise.race([globalThis.fetch(url, init), confidentialDeny.promise]);
        },
      });

      const texts = Array.from({ length: event.inputCount }, (_item, index) => `item-${index}`);
      const firstText = texts[0] ?? "item-0";
      const run = event.inputCount === 1
        ? runWithConfidentialInference(
            authority,
            { agentId: runtime.agentId, modelType: ModelType.TEXT_EMBEDDING, handler: handleTextEmbedding },
            () => handleTextEmbedding(runtime, { text: firstText, signal: controller.signal }).then((v) => [v]),
          )
        : runWithConfidentialInference(
            authority,
            { agentId: runtime.agentId, modelType: ModelType.TEXT_EMBEDDING_BATCH, handler: handleBatchTextEmbedding },
            () => handleBatchTextEmbedding(runtime, texts, controller.signal),
          );
      void run.catch(() => undefined);
      slot.pendingRun = run;

      const originalAction = async () => firstPaused.promise;
      const reached = await Promise.race([
        originalAction().then((p) => ({ ok: true as const, paused: p })),
        run.then(
          () => ({ ok: false as const }),
          () => ({ ok: false as const }),
        ),
      ]);
      if (!reached.ok) {
        slot.controller = undefined;
        slot.pendingRun = undefined;
        slot.nextPaused = undefined;
        return "refused";
      }
      slot.state = {
        phase: "Awaiting",
        attempt: "PrimaryAttempt",
        count: event.inputCount,
        width: event.width,
        hasFallback: event.hasFallback,
      };
      return "accepted";
    }

    if (event.type === "finishEmbedding") {
      if (slot.state.phase !== "Awaiting" || slot.state.count === 0 || !slot.paused || slot.paused.attempt !== event.attempt) {
        return "refused";
      }
      const rejected = await probeRowsRejected(slot.state.width, slot.state.count, event.rows);
      if (rejected) return "refused";
      const paused = slot.paused;
      slot.paused = undefined;
      paused.action.resolve({ kind: "respond", status: 200, body: rowsToWire(event.rows) });
      const vectors = await slot.pendingRun!;
      if (vectors.length !== slot.state.count || vectors.some((v) => v.length !== slot.state.width)) {
        throw new Error("shell returned unexpected vector shape");
      }
      slot.pendingRun = undefined;
      slot.controller = undefined;
      slot.state = { ...slot.state, phase: "EmbeddingSucceeded" };
      return "accepted";
    }

    if (event.type === "failEmbedding") {
      if (slot.state.phase !== "Awaiting" || slot.state.count === 0 || !slot.paused || slot.paused.attempt !== event.attempt) {
        return "refused";
      }
      const paused = slot.paused;
      slot.paused = undefined;
      if (event.attempt === "PrimaryAttempt" && slot.state.hasFallback && event.allowFallback) {
        const nextWait = Promise.withResolvers<PausedAttempt>();
        slot.nextPaused = nextWait;
        paused.action.resolve({ kind: "respond", status: 503, body: { error: { message: "primary failed" } } });
        const fallbackPaused = await nextWait.promise;
        if (fallbackPaused.attempt !== "FallbackAttempt") {
          throw new Error(`expected FallbackAttempt, got ${fallbackPaused.attempt}`);
        }
        slot.state = { ...slot.state, attempt: "FallbackAttempt" };
        return "accepted";
      }
      if (event.attempt === "PrimaryAttempt" && slot.state.hasFallback && !event.allowFallback) {
        slot.confidentialDeny?.reject(Object.assign(new Error("confidential denied"), { code: "CONFIDENTIAL_INFERENCE_DENIED" }));
        slot.confidentialDeny = undefined;
        paused.action.resolve({ kind: "abort" });
        const err = await slot.pendingRun!.then(() => undefined, (cause: unknown) => cause);
        if (err === undefined) throw new Error("expected confidential denial to fail embedding");
        slot.pendingRun = undefined;
        slot.controller = undefined;
        slot.state = { ...slot.state, phase: "EmbeddingExhausted" };
        return "accepted";
      }
      paused.action.resolve({ kind: "respond", status: 503, body: { error: { message: "endpoint failed" } } });
      const err = await slot.pendingRun!.then(() => undefined, (cause: unknown) => cause);
      if (err === undefined) throw new Error("expected exhausted embedding to reject");
      slot.pendingRun = undefined;
      slot.controller = undefined;
      slot.state = { ...slot.state, phase: "EmbeddingExhausted" };
      return "accepted";
    }

    if (event.type === "cancelEmbedding") {
      if (slot.state.phase !== "Awaiting") return "refused";
      if (slot.state.count === 0) {
        const aborted = new AbortController();
        aborted.abort(new Error("cancelled before begin"));
        const runtime = makeRuntime({
          EMBEDDING_BASE_URL: `${root}/probe`,
          EMBEDDING_DIMENSIONS: "384",
          EMBEDDING_FALLBACK_BASE_URL: "",
        });
        const err = await handleTextEmbedding(runtime, { text: "cancel", signal: aborted.signal }).then(
          () => undefined,
          (cause: unknown) => cause,
        );
        if (!isAbortError(err)) throw new Error("expected ABORT_ERR on pre-aborted embedding");
        slot.state = { ...slot.state, phase: "EmbeddingCancelled" };
        return "accepted";
      }
      slot.controller?.abort(new Error("cancelled"));
      const paused = slot.paused;
      slot.paused = undefined;
      paused?.action.resolve({ kind: "abort" });
      const err = await slot.pendingRun!.then(() => undefined, (cause: unknown) => cause);
      if (!isAbortError(err)) throw new Error("expected ABORT_ERR on cancelled embedding");
      slot.pendingRun = undefined;
      slot.controller = undefined;
      slot.state = { ...slot.state, phase: "EmbeddingCancelled" };
      return "accepted";
    }

    return "refused";
  },

  observe(key: string): EmbeddingRun {
    return { ...slotOf(key).state };
  },

  async [Symbol.asyncDispose]() {
    for (const slot of slots.values()) {
      const pending = slot.pendingRun;
      abortSlot(slot);
      if (pending) await pending.catch(() => undefined);
    }
    slots.clear();
    if (server) {
      const closing = server;
      server = undefined;
      closing.closeAllConnections();
      await new Promise<void>((resolve) => { closing.close(() => resolve()); });
    }
  },
};

export const options: Options = { keys: ["a", "b"], walks: 20, steps: 20 };
