/**
 * Exercises the installed iOS fetch boundary with real Fetch objects and a
 * deterministic native plugin. Native execution is simulated; HTTP semantics,
 * stream events and cancellation lifecycle use the production transport.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  installIosLocalAgentFetchBridge,
  primeIosFullBunRuntime,
} from "./ios-local-agent-transport";

const remoteFetch = vi.fn(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    return new Response(await request.text());
  },
);
let bridgedFetch: typeof fetch | undefined;
const native = vi.hoisted(() => ({
  call: vi.fn(),
  listeners: new Map<string, (event: unknown) => void>(),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    isPluginAvailable: (name: string) => name === "ElizaBunRuntime",
  },
  registerPlugin: vi.fn(),
}));
vi.mock("./ios-local-agent-kernel", () => ({
  startIosLocalAgentKernel: () => {
    throw new Error("Unexpected compatibility fallback");
  },
  handleIosLocalAgentRequest: () => {
    throw new Error("Unexpected compatibility fallback");
  },
}));

beforeEach(() => {
  native.call.mockReset();
  native.listeners.clear();
  native.call.mockResolvedValue({
    result: {
      status: 200,
      statusText: "OK",
      headers: {},
      body: "native response",
    },
  });
  remoteFetch.mockClear();
  vi.stubGlobal("fetch", bridgedFetch ?? remoteFetch);
  vi.stubGlobal("window", {
    location: { href: "capacitor://localhost/" },
    navigator: { userAgent: "vitest" },
  });
  vi.stubGlobal("localStorage", { getItem: () => "local" });
  vi.stubEnv("VITE_ELIZA_IOS_FULL_BUN_STRICT", "1");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function install() {
  primeIosFullBunRuntime({
    start: async () => ({ ok: true }),
    getStatus: async () => ({ ready: true, engine: "bun" }),
    call: native.call,
    addListener: async (name: string, listener: (event: unknown) => void) => {
      native.listeners.set(name, listener);
      return {
        remove: () => {
          native.listeners.delete(name);
        },
      };
    },
  });
  installIosLocalAgentFetchBridge();
  bridgedFetch = globalThis.fetch;
}
const endpoint = "eliza-local-agent://ipc/api/example";

it("applies method, body, headers and signal overrides to Request input", async () => {
  await install();
  const originalAbort = new AbortController();
  originalAbort.abort(new Error("old signal"));
  const request = new Request(endpoint, {
    method: "POST",
    body: "old body",
    headers: { "X-Version": "old" },
    signal: originalAbort.signal,
  });
  const response = await fetch(request, {
    method: "PUT",
    body: "new body",
    headers: { "X-Version": "new" },
    signal: new AbortController().signal,
  });
  expect(await response.text()).toBe("native response");
  expect(native.call).toHaveBeenCalledWith({
    method: "http_request",
    args: expect.objectContaining({
      method: "PUT",
      body: "new body",
      path: "/api/example",
      headers: expect.objectContaining({ "x-version": "new" }),
    }),
  });
});

it("inherits an original body and permits replacing a consumed body", async () => {
  await install();
  const request = new Request(endpoint, { method: "POST", body: "original" });
  await (await fetch(request)).text();
  expect(native.call.mock.calls[0][0].args.body).toBe("original");
  expect(request.bodyUsed).toBe(true);
  await (await fetch(request, { body: "replacement" })).text();
  expect(native.call.mock.calls[1][0].args.body).toBe("replacement");
  await expect(fetch(request)).rejects.toThrow();
  expect(native.call).toHaveBeenCalledTimes(2);
});

it("delegates remote RequestInit validation without cloning the original", async () => {
  const original = remoteFetch;
  await install();
  const request = new Request("https://remote.example/resource", {
    method: "POST",
    body: "old",
  });
  await request.text();
  const init = { body: "new" };
  expect(await (await fetch(request, init)).text()).toBe("new");
  expect(original).toHaveBeenCalledWith(request, init);
  expect(native.call).not.toHaveBeenCalled();
});

it("rejects a GET body through the Fetch constructor before dispatch", async () => {
  await install();
  await expect(
    fetch(new Request(endpoint), { body: "invalid" }),
  ).rejects.toThrow();
  expect(native.call).not.toHaveBeenCalled();
});

it("does not dispatch an already aborted override signal", async () => {
  await install();
  const reason = new Error("cancelled by caller");
  await expect(
    fetch(new Request(endpoint), { signal: AbortSignal.abort(reason) }),
  ).rejects.toBe(reason);
  expect(native.call).not.toHaveBeenCalled();
});

it("rejects cancellation while a buffered native operation is pending", async () => {
  await install();
  const pending = Promise.withResolvers<{ result: unknown }>();
  native.call.mockReturnValue(pending.promise);
  const abort = new AbortController();
  const request = fetch(endpoint, { signal: abort.signal });
  const reason = new Error("cancel buffered wait");
  const rejected = expect(request).rejects.toBe(reason);
  await vi.waitFor(() => expect(native.call).toHaveBeenCalledTimes(1));
  abort.abort(reason);
  await rejected;
  pending.resolve({
    result: { status: 200, statusText: "OK", headers: {}, body: "late" },
  });
});

it("aborts a buffered response body after its headers have arrived", async () => {
  await install();
  const abort = new AbortController();
  const response = await fetch(endpoint, { signal: abort.signal });
  const reason = new Error("cancel body read");
  abort.abort(reason);
  await expect(response.text()).rejects.toBe(reason);
});

it.each([false, true])(
  "cancels a native stream after headers=%s without buffered redispatch",
  async (afterHeaders) => {
    await install();
    const completion = Promise.withResolvers<{ result: unknown }>();
    native.call.mockReturnValue(completion.promise);
    const abort = new AbortController();
    const request = fetch(endpoint, {
      headers: { accept: "text/event-stream" },
      signal: abort.signal,
    });
    const reason = new Error("cancel stream");
    const rejected = afterHeaders ? null : expect(request).rejects.toBe(reason);
    await vi.waitFor(() => expect(native.listeners.size).toBe(3));
    const streamId = native.call.mock.calls[0][0].args.streamId;
    let body: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
    if (afterHeaders) {
      native.listeners.get("agentStreamResponse")?.({ streamId, status: 200 });
      const response = await request;
      if (!response.body) throw new Error("Native stream returned no body");
      body = response.body.getReader().read();
    }
    const bodyRejected = body ? expect(body).rejects.toBe(reason) : null;
    abort.abort(reason);
    await rejected;
    await bodyRejected;
    expect(native.listeners.size).toBe(0);
    expect(native.call).toHaveBeenCalledTimes(1);
    expect(native.call.mock.calls[0][0].method).toBe("http_request_stream");
    completion.resolve({ result: null });
  },
);

it("does not replay a failed native streaming POST through buffered transport", async () => {
  await install();
  const failure = new Error("Native stream failed after accepting the message");
  native.call.mockRejectedValueOnce(failure);
  await expect(
    fetch(endpoint, {
      method: "POST",
      headers: { accept: "text/event-stream" },
      body: "one message",
    }),
  ).rejects.toBe(failure);
  expect(native.call).toHaveBeenCalledTimes(1);
  expect(native.call.mock.calls[0][0].method).toBe("http_request_stream");
  expect(native.listeners.size).toBe(0);
});

it("uses buffered compatibility before dispatch when stream events are unavailable", async () => {
  await install();
  primeIosFullBunRuntime({
    start: async () => ({ ok: true }),
    getStatus: async () => ({ ready: true, engine: "bun" }),
    call: native.call,
  });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { accept: "text/event-stream" },
    body: "one message",
  });
  expect(await response.text()).toBe("native response");
  expect(native.call).toHaveBeenCalledTimes(1);
  expect(native.call.mock.calls[0][0].method).toBe("http_request");
});

it.each(["event", "promise"])(
  "rejects a missing native response head completed by %s without replay",
  async (completionKind) => {
    await install();
    const completion = Promise.withResolvers<{ result: unknown }>();
    native.call.mockReturnValue(completion.promise);
    const request = fetch(endpoint, {
      method: "POST",
      headers: { accept: "text/event-stream" },
      body: "one message",
    });
    const rejected = expect(request).rejects.toMatchObject({
      code: "NATIVE_STREAM_RESPONSE_MISSING",
    });
    await vi.waitFor(() => expect(native.listeners.size).toBe(3));
    const streamId = native.call.mock.calls[0][0].args.streamId;
    native.listeners.get("agentStreamChunk")?.({
      streamId,
      dataBase64: btoa("The server refused this message"),
    });
    if (completionKind === "event") {
      native.listeners.get("agentStreamComplete")?.({ streamId });
    } else completion.resolve({ result: { streamId, done: true } });
    await rejected;
    expect(native.call).toHaveBeenCalledTimes(1);
    expect(native.call.mock.calls[0][0].method).toBe("http_request_stream");
    expect(native.listeners.size).toBe(0);
  },
);
