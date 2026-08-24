/**
 * Exercises the browser-safe stub module for Node built-in subpaths through
 * its real exports: inert util/stream no-ops, the stream/web re-export bound
 * to the runtime's real Web Streams, async fallback accessors resolving to
 * their inert values, the constructible telegram stubs, and the default
 * module record. Deterministic unit harness, no mocks.
 */
import { describe, expect, it } from "vitest";
import emptyNodeModule, {
  Api,
  createIntegrationTelemetrySpan,
  DEFAULT_MAX_BODY_BYTES,
  extractActionParamsViaLlm,
  finished,
  hasAdminAccess,
  hasOwnerAccess,
  hasPrivateAccess,
  isArrayBuffer,
  isTypedArray,
  loadElizaConfig,
  pipeline,
  readRequestBody,
  readRequestBodyBuffer,
  StringSession,
  TelegramClient,
  TransformStream,
  WritableStream,
} from "./empty-node-module";

describe("node:util/types guard stubs", () => {
  it("reports false without inspecting any value", () => {
    expect(isArrayBuffer()).toBe(false);
    expect(isTypedArray()).toBe(false);
  });
});

describe("node:stream/promises helper stubs", () => {
  it("leaves pipeline calls inert even when handed real streams", () => {
    expect(pipeline()).toBeUndefined();
    const call = pipeline as unknown as (...args: unknown[]) => unknown;
    const stream = new WritableStream();
    expect(call(stream, stream)).toBeUndefined();
  });

  it("leaves finished calls inert even when handed a real stream", () => {
    expect(finished()).toBeUndefined();
    const call = finished as unknown as (...args: unknown[]) => unknown;
    expect(call(new WritableStream())).toBeUndefined();
  });
});

describe("stream/web re-exports", () => {
  it("binds each export to the runtime's own global Web Stream constructor", () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    expect(globals.ReadableStream).toBeDefined();
    expect(ReadableStream).toBe(globals.ReadableStream);
    expect(WritableStream).toBe(globals.WritableStream);
    expect(TransformStream).toBe(globals.TransformStream);
  });

  it("exposes a functioning ReadableStream, not an empty class", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue("tick");
        controller.close();
      },
    });
    const chunks: string[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["tick"]);
  });
});

describe("@elizaos/agent browser fallback stubs", () => {
  it("denies admin, owner, and private access probes", async () => {
    await expect(hasAdminAccess()).resolves.toBe(false);
    await expect(hasOwnerAccess()).resolves.toBe(false);
    await expect(hasPrivateAccess()).resolves.toBe(false);
  });

  it("resolves action-parameter extraction to an empty object", async () => {
    await expect(extractActionParamsViaLlm()).resolves.toEqual({});
  });

  it("reads request bodies as null in the browser build", async () => {
    await expect(readRequestBody()).resolves.toBeNull();
    await expect(readRequestBodyBuffer()).resolves.toBeNull();
  });

  it("pins the request-body cap at exactly 1 MiB", () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(1_048_576);
  });

  it("returns the empty agent config skeleton", () => {
    expect(loadElizaConfig()).toEqual({ agents: {}, meta: {}, ui: {} });
  });

  it("returns a telemetry span whose success and failure sinks are callable", () => {
    const span = createIntegrationTelemetrySpan();
    expect(span.success()).toBeUndefined();
    expect(() => span.failure()).not.toThrow();
  });
});

describe("telegram stubs", () => {
  it("constructs TelegramClient without arguments", () => {
    const client = new TelegramClient();
    expect(client).toBeInstanceOf(TelegramClient);
  });

  it("exposes Api as an inert object namespace", () => {
    expect(Api).toEqual({});
  });

  it("retains the StringSession value it is constructed with", () => {
    expect(new StringSession("session-payload").value).toBe("session-payload");
  });

  it("defaults StringSession to an empty value", () => {
    expect(new StringSession().value).toBe("");
  });
});

describe("default export", () => {
  it("is an inert module record", () => {
    expect(emptyNodeModule).toEqual({});
  });
});
