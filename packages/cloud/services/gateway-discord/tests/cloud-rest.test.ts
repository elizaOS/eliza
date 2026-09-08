/** Exercises the gateway REST adapter against real delayed-body HTTP responses and caller cancellation. */
import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { fetchWithTimeout, sendCloudUpdate } from "../src/cloud-rest";

let server: Server;
let responseStarted: Promise<void>;
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function listen(status: number, finish: boolean) {
  let markStarted!: () => void;
  responseStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  server = createServer((_req, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.write('{"message":');
    markStarted();
    if (finish) response.end('"complete diagnostic"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing HTTP address");
  return `http://127.0.0.1:${address.port}`;
}

test.each([200, 503])(
  "times out stalled %s response bodies",
  async (status) => {
    const url = await listen(status, false);
    await expect(fetchWithTimeout(url, { timeout: 50 })).rejects.toMatchObject({
      name: "TimeoutError",
    });
  },
);

test("preserves non-success status and complete diagnostic body", async () => {
  const response = await fetchWithTimeout(await listen(503, true));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ message: "complete diagnostic" });
});

test("honors caller cancellation while reading the body", async () => {
  const url = await listen(200, false);
  const controller = new AbortController();
  const result = fetchWithTimeout(url, { signal: controller.signal });
  await responseStarted;
  const reason = new Error("caller stopped");
  controller.abort(reason);
  await expect(result).rejects.toBe(reason);
});

test("rejects failed state writes with complete upstream diagnostics", async () => {
  await expect(
    sendCloudUpdate(await listen(503, true), { method: "POST" }),
  ).rejects.toMatchObject({
    code: "DISCORD_CLOUD_UPDATE_FAILED",
    message:
      'Cloud state update failed (503): {"message":"complete diagnostic"}',
    context: { status: 503 },
  });
});

test("acknowledges a successful state write", async () => {
  await expect(
    sendCloudUpdate(await listen(200, true), { method: "POST" }),
  ).resolves.toBeUndefined();
});
