import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readAndroidOwnerReminderContext } from "./android-owner-reminder-context.js";

const wire = vi.hoisted(() => ({
  path: "",
  requests: [] as Record<string, unknown>[],
}));
vi.mock("node:net", async (original) => {
  const actual = await original<typeof import("node:net")>();
  return {
    ...actual,
    connect: (name: string) => {
      expect(name).toBe("\0owned.native.secure-store");
      return actual.connect(wire.path);
    },
  };
});
let server: Server, directory: string;
afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
  wire.requests = [];
});
const context = () => ({
  protocol: 1,
  subjectUserId: "native-owner",
  agentId: "native-agent",
  installationId: "native-install",
  enrollmentId: "native-enrollment",
  accountRef: "cloud:production:owned-reference",
  environment: "production",
  sessionGeneration: "durable-native-generation",
});
async function broker(
  reply: (request: Record<string, unknown>) => Promise<unknown> | unknown,
) {
  directory = await mkdtemp(join(tmpdir(), "native-owner-context-"));
  wire.path = join(directory, "broker.sock");
  server = createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on("data", async (chunk) => {
      pending = Buffer.concat([
        pending,
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      ]);
      if (pending.length < 4 || pending.length < pending.readUInt32LE() + 4)
        return;
      const request = JSON.parse(pending.subarray(4).toString());
      wire.requests.push(request);
      const result = await reply(request);
      if (socket.destroyed) return;
      const encoded = Buffer.from(JSON.stringify(result)),
        header = Buffer.alloc(4);
      header.writeUInt32LE(encoded.length);
      socket.write(header.subarray(0, 2));
      socket.write(Buffer.concat([header.subarray(2), encoded.subarray(0, 3)]));
      socket.end(encoded.subarray(3));
    });
  });
  await new Promise<void>((resolve) => server.listen(wire.path, resolve));
}
const read = (assertCurrent = () => {}) =>
  readAndroidOwnerReminderContext(
    "owned.native.secure-store",
    "native-agent",
    assertCurrent,
  );
it("reads the exact nonsecret native context across actual split frames with no caller authority fields", async () => {
  await broker((r) => ({ id: r.id, ok: true, context: context() }));
  const result = await read();
  expect(result).toEqual(context());
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.keys(wire.requests[0]).sort()).toEqual(["id", "operation"]);
  expect(wire.requests[0].operation).toBe("nativeOwnerContext");
});
it("does not cache a prior native generation", async () => {
  let generation = 0;
  await broker((r) => ({
    id: r.id,
    ok: true,
    context: { ...context(), sessionGeneration: String(++generation) },
  }));
  expect((await read()).sessionGeneration).toBe("1");
  expect((await read()).sessionGeneration).toBe("2");
  expect(wire.requests).toHaveLength(2);
});
it("keeps absent native composition unavailable", async () => {
  await broker((r) => ({ id: r.id, ok: false, reason: "unavailable" }));
  await expect(read()).rejects.toMatchObject({
    code: "NATIVE_OWNER_CONTEXT_UNAVAILABLE",
  });
});
it("rejects a foreign frame receipt", async () => {
  await broker(() => ({ id: "foreign-request", ok: true, context: context() }));
  await expect(read()).rejects.toMatchObject({
    code: "NATIVE_OWNER_CONTEXT_UNAVAILABLE",
  });
});
it.each([
  { token: "must-not-leak" },
  { agentId: "other-agent" },
  { protocol: 2 },
  { sessionGeneration: "" },
  { subjectUserId: undefined },
])("rejects unbound or extra native projection fields %j", async (change) => {
  await broker((r) => ({
    id: r.id,
    ok: true,
    context: { ...context(), ...change },
  }));
  await expect(read()).rejects.toMatchObject({
    code: "NATIVE_OWNER_CONTEXT_MISMATCH",
  });
});
it.each(["runtime", "account", "room"])(
  "does not publish a held context after %s retirement",
  async () => {
    let current = true,
      release!: () => void,
      admitted!: () => void;
    const entered = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    await broker(async (r) => {
      admitted();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { id: r.id, ok: true, context: context() };
    });
    const pending = read(() => {
      if (!current) throw Error("Retired original owner");
    });
    await entered;
    current = false;
    release();
    await expect(pending).rejects.toThrow("Retired original owner");
  },
);
