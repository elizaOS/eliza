/** Tests managed DoorDash session isolation, login handoff, and checkout deduplication with deterministic provider fakes. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const values = new Map<string, unknown>();
const guards = new Map<string, Record<string, unknown> | null>();
const deletedSessions: string[] = [];
const createdSessions: string[] = [];
const operations: Array<{ name: string; args: Record<string, unknown> }> = [];
let nextSession = 1;
let executionOutputs: unknown[] = [];
let scopedBindings: Record<string, unknown> | undefined;

mock.module("../cache/client", () => ({
  cache: {
    get: async <T>(key: string) => (values.get(key) as T | undefined) ?? null,
    del: async (key: string) => {
      values.delete(key);
    },
    getAndDelete: async <T>(key: string) => {
      const value = (values.get(key) as T | undefined) ?? null;
      values.delete(key);
      return value;
    },
    setWithOutcome: async (key: string, value: unknown) => {
      values.set(key, value);
      return { kind: "written", backend: "memory" };
    },
  },
}));

mock.module("../runtime/cloud-bindings", () => ({
  getCloudAwareEnv: () => process.env,
  runWithCloudBindings: <T>(bindings: Record<string, unknown>, fn: () => T) => {
    const previous = scopedBindings;
    scopedBindings = bindings;
    try {
      return fn();
    } finally {
      scopedBindings = previous;
    }
  },
  getCloudBinding: (name: string) =>
    scopedBindings?.[name] ??
    (name === "DOORDASH_CHECKOUT_GATES"
      ? {
          getByName: () => ({
            fetch: async (request: Request) => {
              const body = (await request.json()) as {
                digest: string;
                receipt?: Record<string, unknown>;
              };
              if (new URL(request.url).pathname === "/complete") {
                if (!guards.has(body.digest) || !body.receipt) {
                  return Response.json({ completed: false }, { status: 409 });
                }
                guards.set(body.digest, body.receipt);
                return Response.json({ completed: true, receipt: body.receipt });
              }
              if (guards.has(body.digest)) {
                const receipt = guards.get(body.digest);
                if (receipt) {
                  return Response.json({ completed: true, receipt });
                }
                return Response.json({ claimed: false }, { status: 409 });
              }
              guards.set(body.digest, null);
              return Response.json({ claimed: true }, { status: 201 });
            },
          }),
        }
      : undefined),
}));

mock.module("./doordash-browser-run", () => ({
  createDoorDashBrowserSession: async () => {
    const id = `session-${nextSession++}`;
    createdSessions.push(id);
    return {
      id,
      interactiveLiveViewUrl: `https://login.example/${id}`,
    };
  },
  getDoorDashBrowserSession: async (id: string) => ({
    id,
    interactiveLiveViewUrl: `https://login.example/${id}`,
  }),
  deleteDoorDashBrowserSession: async (id: string) => {
    deletedSessions.push(id);
  },
  executeDoorDashBrowserOperation: async (
    _id: string,
    name: string,
    args: Record<string, unknown>,
  ) => {
    operations.push({ name, args });
    return executionOutputs.shift();
  },
}));

const { callManagedDoorDashTool, getManagedDoorDashSessionKey } = await import(
  "./doordash-managed"
);

const auth = (userId: string) => ({ organizationId: "org-1", userId });

beforeEach(() => {
  values.clear();
  guards.clear();
  deletedSessions.length = 0;
  createdSessions.length = 0;
  operations.length = 0;
  nextSession = 1;
  executionOutputs = [];
});

describe("managed DoorDash", () => {
  test("returns a user-specific interactive login handoff", async () => {
    executionOutputs = [{ loggedIn: false, url: "https://www.doordash.com/" }];
    const result = await callManagedDoorDashTool("doordash_auth_check", {}, auth("user-1"));
    expect(result).toMatchObject({
      success: true,
      authRequired: true,
      loginUrl: "https://login.example/session-1",
      appBrowserPath: "/browser?browse=https%3A%2F%2Flogin.example%2Fsession-1",
    });
  });

  test("explains the human handoff when DoorDash challenges Browser Run", async () => {
    executionOutputs = [
      {
        loggedIn: false,
        securityVerificationRequired: true,
        url: "https://www.doordash.com/",
      },
    ];
    const result = await callManagedDoorDashTool("doordash_auth_check", {}, auth("user-1"));
    expect(result).toMatchObject({
      success: true,
      authRequired: true,
      securityVerificationRequired: true,
    });
    expect(result.instructions).toContain("complete DoorDash's security verification");
  });

  test("keeps same-organization users in distinct hosted sessions", async () => {
    executionOutputs = [
      { loggedIn: true, url: "https://www.doordash.com/" },
      { loggedIn: true, url: "https://www.doordash.com/" },
    ];
    await callManagedDoorDashTool("doordash_auth_check", {}, auth("user-1"));
    await callManagedDoorDashTool("doordash_auth_check", {}, auth("user-2"));
    expect(getManagedDoorDashSessionKey(auth("user-1"))).not.toBe(
      getManagedDoorDashSessionKey(auth("user-2")),
    );
    expect(createdSessions).toEqual(["session-1", "session-2"]);
  });

  test("replays the same authoritative receipt without submitting twice", async () => {
    const preview = { success: true, summary: { total: 24.5, deliveryAddress: "1 Main" } };
    executionOutputs = [preview, { success: true, orderId: "abc-123" }, preview];
    const first = await callManagedDoorDashTool(
      "doordash_checkout",
      { confirm: true },
      auth("user-1"),
    );
    expect(first).toMatchObject({ success: true, orderId: "abc-123" });
    values.clear();
    const replay = await callManagedDoorDashTool(
      "doordash_checkout",
      { confirm: true },
      auth("user-1"),
    );
    expect(replay).toEqual(first);
    expect(createdSessions).toEqual(["session-1", "session-2"]);
    expect(operations).toHaveLength(3);
  });

  test("rejects a synthetic checkout receipt", async () => {
    executionOutputs = [
      { success: true, summary: { total: 24.5 } },
      { success: true, orderId: "order-12345" },
    ];

    await expect(
      callManagedDoorDashTool("doordash_checkout", { confirm: true }, auth("user-1")),
    ).rejects.toThrow("outcome is ambiguous");
  });

  test("rejects malformed direct MCP arguments before browser execution", async () => {
    await expect(
      callManagedDoorDashTool(
        "doordash_add_to_cart",
        { restaurantId: "store-1", itemName: "Soup", quantity: 0 },
        auth("user-1"),
      ),
    ).rejects.toThrow("quantity must be an integer");
    expect(createdSessions).toEqual([]);
    expect(operations).toEqual([]);
  });
});
