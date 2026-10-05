import { afterEach, expect, test, vi } from "vitest";

const { rpcRequest } = vi.hoisted(() => ({ rpcRequest: vi.fn() }));
vi.mock("../../../../ui/src/bridge/electrobun-rpc", () => ({
  getElectrobunRendererRpc: () => ({
    request: { localAgentRequest: rpcRequest },
  }),
}));
vi.mock("../../../../ui/src/bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: () => true,
}));

import { desktopLocalAgentTransportForUrl } from "./desktop-local-agent-transport";

const url = "eliza-local-agent://ipc/api/example";
const transport = await desktopLocalAgentTransportForUrl(url);
if (!transport) throw new Error("Expected desktop IPC transport");
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});
test.each([204, 205, 304])(
  "desktop IPC handles bodyless status %s",
  async (status) => {
    rpcRequest.mockResolvedValueOnce({ status, body: "ignored" });
    const result = await transport.request(url, { method: "DELETE" });
    expect(result.status).toBe(status);
    expect(result.body).toBeNull();
  },
);
test.each([new Blob(["payload"]), new FormData(), new ArrayBuffer(2)])(
  "rejects unsupported body before dispatch: %s",
  async (body) => {
    await expect(
      transport.request(url, { method: "POST", body }),
    ).rejects.toThrow(TypeError);
    expect(rpcRequest).not.toHaveBeenCalled();
  },
);
test.each(["payload", new URLSearchParams({ value: "a b" }), null])(
  "preserves supported body: %s",
  async (body) => {
    rpcRequest.mockResolvedValueOnce({ status: 200, body: "ok" });
    expect(
      await (await transport.request(url, { method: "POST", body })).text(),
    ).toBe("ok");
    expect(rpcRequest).toHaveBeenCalledWith(
      expect.objectContaining({ body: body?.toString() ?? null }),
    );
  },
);
test("decodes binary bridge responses exactly", async () => {
  rpcRequest.mockResolvedValueOnce({ status: 200, bodyBase64: "AP+A" });
  const response = await transport.request(url, {});
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
    0, 255, 128,
  ]);
});
test("preserves bridge failures", async () => {
  const error = new Error("bridge failed");
  rpcRequest.mockRejectedValueOnce(error);
  await expect(transport.request(url, {})).rejects.toBe(error);
});
test("does not dispatch an already cancelled request", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    transport.request(url, { signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(rpcRequest).not.toHaveBeenCalled();
});
test("cancels a pending wait without dispatching again", async () => {
  rpcRequest.mockImplementationOnce(() => new Promise(() => {}));
  const controller = new AbortController();
  const result = transport.request(url, { signal: controller.signal });
  const assertion = expect(result).rejects.toMatchObject({
    name: "AbortError",
  });
  controller.abort();
  await assertion;
  expect(rpcRequest).toHaveBeenCalledTimes(1);
});
test("times out a pending wait without retrying", async () => {
  vi.useFakeTimers();
  rpcRequest.mockImplementationOnce(() => new Promise(() => {}));
  const assertion = expect(
    transport.request(url, {}, { timeoutMs: 20 }),
  ).rejects.toMatchObject({ name: "TimeoutError" });
  await vi.advanceTimersByTimeAsync(20);
  await assertion;
  expect(rpcRequest).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
