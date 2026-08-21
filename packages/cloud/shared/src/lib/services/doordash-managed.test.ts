/** Tests managed DoorDash session isolation, login handoff, and checkout deduplication with deterministic provider fakes. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const values = new Map<string, unknown>();
const guards = new Set<string>();
const deletedSessions: string[] = [];
const createdSessions: string[] = [];
const scripts: string[] = [];
let nextSession = 1;
let executionOutputs: unknown[] = [];

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
  getCloudBinding: () => ({
    getByName: () => ({
      fetch: async (request: Request) => {
        const body = (await request.json()) as { digest: string };
        if (guards.has(body.digest)) {
          return Response.json({ claimed: false }, { status: 409 });
        }
        guards.add(body.digest);
        return Response.json({ claimed: true }, { status: 201 });
      },
    }),
  }),
}));

mock.module("./browser-tools", () => ({
  createHostedBrowserSession: async () => {
    const id = `session-${nextSession++}`;
    createdSessions.push(id);
    return {
      id,
      interactiveLiveViewUrl: `https://login.example/${id}`,
      liveViewUrl: null,
    };
  },
  getHostedBrowserSession: async (id: string) => ({
    id,
    interactiveLiveViewUrl: `https://login.example/${id}`,
    liveViewUrl: null,
  }),
  deleteHostedBrowserSession: async (id: string) => {
    deletedSessions.push(id);
  },
  executeHostedBrowserCommand: async (_id: string, command: { script?: string }) => {
    scripts.push(command.script ?? "");
    return { output: executionOutputs.shift() };
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
  scripts.length = 0;
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
    });
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

  test("prevents retrying the same authoritative checkout state", async () => {
    const preview = { success: true, summary: { total: 24.5, deliveryAddress: "1 Main" } };
    executionOutputs = [preview, { success: true, orderId: "abc-123" }, preview];
    const first = await callManagedDoorDashTool(
      "doordash_checkout",
      { confirm: true },
      auth("user-1"),
    );
    expect(first).toMatchObject({ success: true, orderId: "abc-123" });
    await expect(
      callManagedDoorDashTool("doordash_checkout", { confirm: true }, auth("user-1")),
    ).rejects.toThrow("already attempted");
    expect(scripts).toHaveLength(3);
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
    expect(scripts).toEqual([]);
  });
});
