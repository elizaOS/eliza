/**
 * Exercises Android transport replay policy against a real HTTP mutation
 * counter. The native event adapter is deterministic; the production transport
 * and stream lifecycle run unchanged, without an Android device or UDS bridge.
 */
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createAndroidNativeAgentTransport,
  type NativeAgentRequestOptions,
  type NativeAgentRequestResult,
} from "./android-native-agent-transport";

type NativeAgentPlugin = Parameters<
  typeof createAndroidNativeAgentTransport
>[0];

let server: Server;
let serverBase: string;
let mutations: string[];

beforeEach(async () => {
  mutations = [];
  server = createServer((request, response) => {
    request.setEncoding("utf8");
    let body = "";
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      mutations.push(body);
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ mutation: mutations.length, body }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mutation counter has no TCP address");
  }
  serverBase = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
});

async function forward(
  options: NativeAgentRequestOptions,
): Promise<NativeAgentRequestResult> {
  const response = await fetch(`${serverBase}${options.path}`, {
    method: options.method,
    headers: options.headers,
    body: options.body,
  });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  };
}

function nativeAdapter() {
  const listeners = new Map<string, (event: unknown) => void>();
  const attached = Promise.withResolvers<void>();
  const calls = { streamed: 0, buffered: 0, removed: 0 };
  const streamId = "accepted-mutation";
  const plugin: NativeAgentPlugin = {
    async request(options) {
      calls.buffered += 1;
      return forward(options);
    },
    async requestStream(options) {
      calls.streamed += 1;
      // Force acceptance before the renderer observes a missing/failed head.
      // Android likewise writes its request before reading any response frame.
      await forward(options);
      return { streamId };
    },
    async addListener(name, listener) {
      listeners.set(name, listener);
      if (listeners.size === 3) attached.resolve();
      return {
        remove() {
          calls.removed += 1;
          listeners.delete(name);
        },
      };
    },
  };
  return { plugin, listeners, attached: attached.promise, calls, streamId };
}

const endpoint = "eliza-local-agent://ipc/api/mutations/stream";
const payload = JSON.stringify({ text: "Perform one mutation" });
const request = { method: "POST", body: payload };

it.each(["native error", "head timeout"])(
  "does not replay an accepted POST after a pre-header %s",
  async (failure) => {
    const native = nativeAdapter();
    const transport = createAndroidNativeAgentTransport(native.plugin);
    const pending = transport.request(endpoint, request, { timeoutMs: 50 });
    const message =
      failure === "native error"
        ? "Socket read failed after acceptance"
        : "native stream head timeout";
    const rejected = expect(pending).rejects.toThrow(message);
    await native.attached;
    if (failure === "native error") {
      const complete = native.listeners.get("agentStreamComplete");
      if (!complete) throw new Error("Native completion listener is missing");
      complete({ streamId: native.streamId, error: message });
    }
    await rejected;
    expect(mutations).toEqual([payload]);
    expect(native.calls.streamed).toBe(1);
    expect(native.calls.buffered).toBe(0);
    expect(native.calls.removed).toBe(3);
    expect(native.listeners.size).toBe(0);
  },
);

it.each(["requestStream", "addListener"] as const)(
  "uses buffered compatibility before dispatch when %s is unavailable",
  async (missingCapability) => {
    const native = nativeAdapter();
    delete native.plugin[missingCapability];
    const response = await createAndroidNativeAgentTransport(
      native.plugin,
    ).request(endpoint, request);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ mutation: 1, body: payload });
    expect(mutations).toEqual([payload]);
    expect(native.calls.streamed).toBe(0);
    expect(native.calls.buffered).toBe(1);
    expect(native.listeners.size).toBe(0);
  },
);
