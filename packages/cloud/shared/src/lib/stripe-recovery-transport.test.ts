/** Exercises complete-body recovery deadlines against a real loopback HTTP server, including stalled headers, trickling bodies and caller cancellation. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { createStripeRecoveryFetch } from "./stripe-recovery-transport";

const sockets = new Set<Socket>();
const requestedSockets = new Set<Socket>();
let writes = 0;
let origin: string;
const server = createServer((request, response) => {
  if (request.url !== "/complete") requestedSockets.add(request.socket);
  request.socket.once("close", () => requestedSockets.delete(request.socket));
  if (request.method !== "GET") writes++;
  if (request.url === "/headers") return;
  if (request.url === "/complete") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"complete":');
    response.end("true}");
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.flushHeaders();
  response.write('{"value":"');
  if (request.url === "/trickle") {
    const interval = setInterval(() => response.write("x"), 10);
    response.once("close", () => clearInterval(interval));
  }
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback address unavailable");
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
async function waitForCleanup() {
  for (let retry = 0; retry < 50 && requestedSockets.size; retry++) await Bun.sleep(10);
  expect(requestedSockets.size).toBe(0);
}
for (const path of ["headers", "body", "trickle"])
  test(`owned timeout aborts ${path} and closes its actual connection`, async () => {
    const started = Date.now();
    await expect(
      createStripeRecoveryFetch(started + 100)(`${origin}/${path}`, {
        headers: { Connection: "close" },
      }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_RECOVERY_READ_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(1500);
    await waitForCleanup();
  });
test("full JSON is preserved and caller cancellation aborts the body", async () => {
  const response = await createStripeRecoveryFetch(Date.now() + 1000)(`${origin}/complete`, {
    headers: { Connection: "close" },
  });
  expect(await response.json()).toEqual({ complete: true });
  await waitForCleanup();
  const controller = new AbortController();
  const pending = createStripeRecoveryFetch(Date.now() + 1000)(`${origin}/body`, {
    signal: controller.signal,
    headers: { Connection: "close" },
  });
  await Bun.sleep(30);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "SUBSCRIPTION_RECOVERY_READ_FAILED" });
  await waitForCleanup();
});
test("mutation and expired budget reject before provider effects", async () => {
  await expect(
    createStripeRecoveryFetch(Date.now() + 1000)(`${origin}/complete`, { method: "POST" }),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_RECOVERY_READ_ONLY" });
  await expect(
    createStripeRecoveryFetch(Date.now() - 1)(`${origin}/complete`),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_RECOVERY_READ_TIMEOUT" });
  expect(writes).toBe(0);
});
