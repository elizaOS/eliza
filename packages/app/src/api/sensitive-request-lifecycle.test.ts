import http from "node:http";
import { Socket } from "node:net";
import {
  defaultSensitiveRequestPolicy,
  resolveSensitiveRequestDelivery,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleSensitiveRequestRoutes } from "./sensitive-request-routes";
import { LocalSensitiveRequestStore } from "./sensitive-request-store";

vi.mock("./auth.ts", () => ({
  ensureRouteAuthorized: async () => true,
  getCompatApiToken: () => undefined,
  getProvidedApiToken: () => undefined,
  tokenMatches: () => false,
}));

function createRequest(store: LocalSensitiveRequestStore) {
  return store.create({
    kind: "private_info",
    agentId: "local-agent",
    target: {
      kind: "private_info",
      fields: [{ name: "name", required: true }],
    },
    policy: defaultSensitiveRequestPolicy("private_info"),
    delivery: resolveSensitiveRequestDelivery({
      kind: "private_info",
      source: "owner_app_private",
      environment: { ownerApp: { privateChat: true } },
    }),
    now: 1_000,
    ttlMs: 1_000,
  });
}

describe("sensitive request effect lifecycle", () => {
  it("cannot cancel or expire an admitted effect, or overwrite its receipt", () => {
    const store = new LocalSensitiveRequestStore();
    const { record, submitToken } = createRequest(store);
    expect(store.consumeSubmitToken(record.id, submitToken, 1_001).ok).toBe(
      true,
    );
    expect(store.cancel(record.id, 1_002)?.status).toBe("pending");
    expect(store.get(record.id, 3_000)?.status).toBe("pending");
    store.fulfill(
      record.id,
      {
        kind: "private_info.submitted",
        requestId: record.id,
        fields: ["name"],
      },
      3_001,
    );
    store.fail(record.id, "notification_failed", 3_002);
    expect(store.get(record.id, 3_003)?.status).toBe("fulfilled");
  });

  it("does not fulfill a canceled request", () => {
    const store = new LocalSensitiveRequestStore();
    const { record } = createRequest(store);
    store.cancel(record.id, 1_001);
    store.fulfill(
      record.id,
      { kind: "private_info.submitted", requestId: record.id, fields: [] },
      1_002,
    );
    expect(record.status).toBe("canceled");
  });

  it("rejects missing storage without consuming the submit token", async () => {
    const store = new LocalSensitiveRequestStore();
    const { record, submitToken } = createRequest(store);
    const req = Object.assign(new http.IncomingMessage(new Socket()), {
      method: "POST",
      url: `/api/sensitive-requests/${record.id}/submit`,
      headers: {},
      body: { token: submitToken, fields: { name: "Test" } },
    });
    const res = { headersSent: false, setHeader: vi.fn(), end: vi.fn() };
    await handleSensitiveRequestRoutes(
      req,
      res as unknown as http.ServerResponse,
      { current: null, pendingAgentName: null, pendingRestartReasons: [] },
      { store, now: () => 1_001 },
    );
    expect(res).toHaveProperty("statusCode", 503);
    expect(store.checkSubmitToken(record.id, submitToken, 1_002).ok).toBe(true);
  });
});
