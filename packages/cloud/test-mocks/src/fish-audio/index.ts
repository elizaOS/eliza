/**
 * Provides a resettable Fish Audio WebSocket/MessagePack upstream for driving
 * the production Fish client without credentials or provider traffic.
 */

import http from "node:http";

import { decode, encode } from "@msgpack/msgpack";
import { WebSocket, WebSocketServer } from "ws";

export type FishAudioMockFault =
  | "rate_limit"
  | "malformed_frame"
  | "array_frame"
  | "provider_error"
  | "close_early"
  | "stall";

export interface FishAudioMockSeed {
  apiKey: string;
  model: string;
  audioChunks: Uint8Array[];
  chunkDelayMs: number;
}

export interface FishAudioMockObservation {
  order: number;
  generation: number;
  event: "upgrade_rejected" | "frame" | "request" | "closed";
  authorized?: boolean;
  status?: number;
  frameEvent?: string;
  model?: string;
  referenceId?: string;
  text?: string;
  closeCode?: number;
  closeReason?: string;
}

const DEFAULT_SEED: FishAudioMockSeed = {
  apiKey: "synthetic-fish-key",
  model: "s2.1-pro",
  audioChunks: [new Uint8Array([1, 2]), new Uint8Array([3, 4])],
  chunkDelayMs: 0,
};

export class FishAudioMockStore {
  #generation = 1;
  #seed: FishAudioMockSeed;
  #fault: FishAudioMockFault | null = null;
  #observations: FishAudioMockObservation[] = [];
  readonly #connections = new Set<WebSocket>();

  constructor(seed: Partial<FishAudioMockSeed> = {}) {
    this.#seed = normalizeSeed(seed);
  }

  get generation(): number {
    return this.#generation;
  }

  get seed(): FishAudioMockSeed {
    return cloneSeed(this.#seed);
  }

  get fault(): FishAudioMockFault | null {
    return this.#fault;
  }

  get openConnectionCount(): number {
    return this.#connections.size;
  }

  setFault(fault: FishAudioMockFault | null): void {
    this.#fault = fault;
  }

  responsePlan(generation: number): FishAudioResponsePlan | null {
    if (generation !== this.#generation) return null;
    return { fault: this.#fault, seed: cloneSeed(this.#seed) };
  }

  reset(seed: Partial<FishAudioMockSeed> = {}): void {
    this.#generation += 1;
    this.#seed = normalizeSeed(seed);
    this.#fault = null;
    this.#observations = [];
    for (const connection of this.#connections) {
      connection.close(1012, "synthetic environment reset");
    }
  }

  readback(): {
    generation: number;
    fault: FishAudioMockFault | null;
    observations: FishAudioMockObservation[];
  } {
    return {
      generation: this.#generation,
      fault: this.#fault,
      observations: this.#observations.map((entry) => ({ ...entry })),
    };
  }

  addConnection(connection: WebSocket): void {
    this.#connections.add(connection);
  }

  removeConnection(connection: WebSocket): void {
    this.#connections.delete(connection);
  }

  observe(
    observation: Omit<FishAudioMockObservation, "order" | "generation">,
    generation = this.#generation,
  ): void {
    if (generation !== this.#generation) return;
    this.#observations.push({
      ...observation,
      order: this.#observations.length + 1,
      generation: this.#generation,
    });
  }
}

export interface RunningFishAudioMock {
  url: string;
  store: FishAudioMockStore;
  stop(): Promise<void>;
}

export async function startFishAudioMock(
  seed: Partial<FishAudioMockSeed> = {},
): Promise<RunningFishAudioMock> {
  const store = new FishAudioMockStore(seed);
  const server = http.createServer((_request, response) => {
    response.writeHead(426, { "content-type": "text/plain" });
    response.end("WebSocket upgrade required");
  });
  const webSockets = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const authorization = request.headers.authorization;
    const model = singleHeader(request.headers.model);
    const authorized = authorization === `Bearer ${store.seed.apiKey}`;
    const status = !authorized || model !== store.seed.model ? 401 : 101;
    if (status !== 101 || store.fault === "rate_limit") {
      const rejectedStatus = store.fault === "rate_limit" ? 429 : status;
      store.observe({
        event: "upgrade_rejected",
        authorized,
        status: rejectedStatus,
        model,
      });
      const retryAfter = rejectedStatus === 429 ? "Retry-After: 1\r\n" : "";
      socket.write(
        `HTTP/1.1 ${rejectedStatus} ${rejectedStatus === 429 ? "Too Many Requests" : "Unauthorized"}\r\n${retryAfter}Connection: close\r\n\r\n`,
      );
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (connection) => {
      webSockets.emit("connection", connection, request);
    });
  });

  webSockets.on("connection", (connection, request) => {
    const connectionGeneration = store.generation;
    store.addConnection(connection);
    const model = singleHeader(request.headers.model);
    let referenceId: string | undefined;
    let text: string | undefined;
    connection.on("message", (raw) => {
      const frame = decode(new Uint8Array(raw as Buffer)) as Record<
        string,
        unknown
      >;
      const frameEvent = typeof frame.event === "string" ? frame.event : "";
      store.observe(
        { event: "frame", frameEvent, model },
        connectionGeneration,
      );
      if (frameEvent === "start") {
        const requestFrame = frame.request as
          | Record<string, unknown>
          | undefined;
        referenceId =
          typeof requestFrame?.reference_id === "string"
            ? requestFrame.reference_id
            : undefined;
      }
      if (frameEvent === "text" && typeof frame.text === "string") {
        text = frame.text;
      }
      if (frameEvent === "stop") {
        store.observe(
          { event: "request", model, referenceId, text },
          connectionGeneration,
        );
        const responsePlan = store.responsePlan(connectionGeneration);
        if (responsePlan) void respond(connection, responsePlan);
      }
    });
    connection.on("close", (code, reason) => {
      store.removeConnection(connection);
      store.observe(
        {
          event: "closed",
          closeCode: code,
          closeReason: reason.toString(),
        },
        connectionGeneration,
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fish Audio mock did not bind to a numeric port");
  }

  return {
    url: `ws://127.0.0.1:${address.port}/v1/tts/live`,
    store,
    stop: async () => {
      for (const connection of webSockets.clients) connection.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

interface FishAudioResponsePlan {
  fault: FishAudioMockFault | null;
  seed: FishAudioMockSeed;
}

async function respond(
  connection: WebSocket,
  plan: FishAudioResponsePlan,
): Promise<void> {
  const { fault, seed } = plan;
  if (fault === "stall") return;
  if (fault === "malformed_frame") {
    connection.send(new Uint8Array([0xc1]));
    return;
  }
  if (fault === "array_frame") {
    connection.send(encode(["not", "a", "protocol", "object"]));
    return;
  }
  if (fault === "provider_error") {
    connection.send(
      encode({ event: "error", message: "synthetic provider failure" }),
    );
    return;
  }
  if (fault === "close_early") {
    connection.close(1011, "synthetic provider closed early");
    return;
  }
  for (const chunk of seed.audioChunks) {
    if (seed.chunkDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, seed.chunkDelayMs));
    }
    if (connection.readyState !== WebSocket.OPEN) return;
    connection.send(encode({ event: "audio", audio: chunk }));
  }
  if (connection.readyState === WebSocket.OPEN) {
    connection.send(encode({ event: "finish", reason: "stop" }));
    connection.close(1000, "synthesis complete");
  }
}

function normalizeSeed(seed: Partial<FishAudioMockSeed>): FishAudioMockSeed {
  return {
    apiKey: seed.apiKey ?? DEFAULT_SEED.apiKey,
    model: seed.model ?? DEFAULT_SEED.model,
    audioChunks: (seed.audioChunks ?? DEFAULT_SEED.audioChunks).map(
      (chunk) => new Uint8Array(chunk),
    ),
    chunkDelayMs: seed.chunkDelayMs ?? DEFAULT_SEED.chunkDelayMs,
  };
}

function cloneSeed(seed: FishAudioMockSeed): FishAudioMockSeed {
  return normalizeSeed(seed);
}

function singleHeader(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
