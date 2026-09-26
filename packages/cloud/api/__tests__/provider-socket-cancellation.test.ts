/** Real Node WebSocket cancellation exercises DOM adapter teardown without a provider or model stub. */
import { expect, test } from "bun:test";
import { WebSocket } from "ws";
import { wrapNodeWsAsDom } from "../v1/voice/session/lib/harness-real-server.ts";

test("a late handshake error remains diagnostic after the adapter listener detaches", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("No upgrade", { status: 503 }),
  });
  const diagnostics: string[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const wrapped = wrapNodeWsAsDom(socket, {
    log: (_level, message) => diagnostics.push(message),
  });
  let adapterErrors = 0;
  const onError = () => {
    adapterErrors += 1;
  };
  wrapped.addEventListener("error", onError);
  const closed = new Promise<void>((resolve) =>
    socket.once("close", () => resolve()),
  );
  try {
    wrapped.removeEventListener("error", onError);
    wrapped.close();
    await closed;
    expect(adapterErrors).toBe(0);
    expect(diagnostics).toContain("provider WebSocket transport error");
  } finally {
    socket.terminate();
    server.stop(true);
  }
});

test("active adapter errors are still delivered alongside transport diagnostics", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("No upgrade", { status: 503 }),
  });
  const diagnostics: string[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const wrapped = wrapNodeWsAsDom(socket, {
    log: (_level, message) => diagnostics.push(message),
  });
  let adapterErrors = 0;
  wrapped.addEventListener("error", () => {
    adapterErrors += 1;
  });
  const closed = new Promise<void>((resolve) =>
    socket.once("close", () => resolve()),
  );
  try {
    await closed;
    expect(adapterErrors).toBe(1);
    expect(diagnostics).toContain("provider WebSocket transport error");
  } finally {
    socket.terminate();
    server.stop(true);
  }
});
