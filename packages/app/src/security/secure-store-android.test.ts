import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAndroidPlatformSecureStore } from "./secure-store-android";

// macOS lacks Linux abstract sockets. Record their exact wire address, then
// route to a real filesystem broker so the complete framed exchange still runs.
const transport = vi.hoisted(() => ({ path: "", addresses: [] as string[] }));
vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    connect: (path: string) => {
      transport.addresses.push(path);
      return actual.connect(path.startsWith("\0") ? transport.path : path);
    },
  };
});

let server: Server;
let directory: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  transport.addresses.length = 0;
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function broker(
  reply: (request: Record<string, unknown>) => unknown,
  useDefaultSocket = false,
) {
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
  transport.path = socketPath;
  return createAndroidPlatformSecureStore(
    useDefaultSocket ? undefined : socketPath,
    200,
  );
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

it.each([undefined, ""])(
  "retains the default abstract socket for unset/empty override (%s)",
  async (override) => {
    vi.stubEnv("ELIZA_ANDROID_SECURE_STORE_SOCKET", override);
    const store = await broker(
      (r) => ({ id: r.id, ok: false, reason: "not_found" }),
      true,
    );
    expect(await store.isAvailable()).toBe(true);
    expect(transport.addresses).toEqual(["\0ai.elizaos.app.secure-store"]);
  },
);

it("captures the embedding host socket at construction for every operation", async () => {
  vi.stubEnv(
    "ELIZA_ANDROID_SECURE_STORE_SOCKET",
    "ai.example.host.secure-store",
  );
  const store = await broker(
    (r) => ({
      id: r.id,
      ok: true,
      value: "stored",
      deleted: true,
    }),
    true,
  );
  vi.stubEnv("ELIZA_ANDROID_SECURE_STORE_SOCKET", "ai.other.host.secure-store");
  expect(await store.set("vault", "runtime.agent_profiles", "stored")).toEqual({
    ok: true,
  });
  expect(await store.get("vault", "runtime.agent_profiles")).toEqual({
    ok: true,
    value: "stored",
  });
  expect(await store.delete("vault", "runtime.agent_profiles")).toEqual({
    ok: true,
    deleted: true,
  });
  expect(transport.addresses).toEqual(
    Array(3).fill("\0ai.example.host.secure-store"),
  );
});

it("keeps an explicit socket path authoritative over the environment", async () => {
  vi.stubEnv("ELIZA_ANDROID_SECURE_STORE_SOCKET", "ai.other.host.secure-store");
  const store = await broker((r) => ({
    id: r.id,
    ok: false,
    reason: "not_found",
  }));
  expect(await store.isAvailable()).toBe(true);
  expect(transport.addresses).toEqual([transport.path]);
});
