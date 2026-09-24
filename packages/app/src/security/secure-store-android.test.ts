import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createAndroidPlatformSecureStore } from "./secure-store-android";

let server: Server;
let directory: string;
afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function broker(reply: (request: Record<string, unknown>) => unknown) {
  directory = await mkdtemp(join(tmpdir(), "secure-store-"));
  const socketPath = join(directory, "broker.sock");
  server = createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([
        pending,
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      ]);
      if (pending.length < 4 || pending.length < pending.readUInt32LE() + 4)
        return;
      const request = JSON.parse(pending.subarray(4).toString());
      const encoded = Buffer.from(JSON.stringify(reply(request)));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(encoded.length);
      socket.write(header.subarray(0, 2));
      socket.write(Buffer.concat([header.subarray(2), encoded.subarray(0, 3)]));
      socket.end(encoded.subarray(3));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return createAndroidPlatformSecureStore(socketPath, 200);
}

it("preserves complete multilingual values and operation receipts across split native frames", async () => {
  const slots = new Map<string, string>();
  const store = await broker((r) => {
    const key = String(r.vaultId);
    if (r.operation === "set") {
      slots.set(key, String(r.value));
      return { id: r.id, ok: true };
    }
    if (r.operation === "delete")
      return { id: r.id, ok: true, deleted: slots.delete(key) };
    return slots.has(key)
      ? { id: r.id, ok: true, value: slots.get(key) }
      : { id: r.id, ok: false, reason: "not_found" };
  });
  const value = "🦊 私密 \n".repeat(10000);
  expect(await store.set("agent-one", "runtime.agent_profiles", value)).toEqual(
    { ok: true },
  );
  expect(await store.get("agent-one", "runtime.agent_profiles")).toEqual({
    ok: true,
    value,
  });
  expect(await store.get("agent-two", "runtime.agent_profiles")).toEqual({
    ok: false,
    reason: "not_found",
  });
  expect(await store.delete("agent-one", "runtime.agent_profiles")).toEqual({
    ok: true,
    deleted: true,
  });
  expect(await store.delete("agent-one", "runtime.agent_profiles")).toEqual({
    ok: true,
    deleted: false,
  });
});

it("rejects mismatched receipts and unapproved secret slots", async () => {
  let requests = 0;
  const store = await broker(() => {
    requests++;
    return { id: "wrong", ok: true, value: "secret" };
  });
  expect(await store.get("agent", "runtime.agent_profiles")).toEqual({
    ok: false,
    reason: "error",
  });
  expect(await store.get("agent", "wallet.evm_private_key")).toEqual({
    ok: false,
    reason: "denied",
  });
  expect(requests).toBe(1);
});

it("does not report success or retry after a disconnected write", async () => {
  const store = await broker(() => ({ ok: true }));
  expect(await store.set("agent", "runtime.agent_profiles", "private")).toEqual(
    { ok: false, reason: "error" },
  );
});
