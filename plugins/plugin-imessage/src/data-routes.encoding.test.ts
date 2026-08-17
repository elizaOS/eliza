/**
 * PATCH/DELETE /api/imessage/contacts/:id path encoding is leftover tax
 * after the messages-list limit parser. Stock develop called
 * decodeURIComponent on the contact id, so `%` / `%2` / `%ZZ` threw
 * URIError (500) instead of a typed 400. Messages list stays untouched.
 */
import type { IAgentRuntime, RouteRequest, RouteResponse } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  buildSetupError: (code: string, message: string) => ({
    error: { code, message },
  }),
}));

import { imessageDataRoutes } from "./data-routes.ts";

const patchRoute = imessageDataRoutes.find(
  (route) => route.type === "PATCH" && route.path === "/api/imessage/contacts/:id"
);
const deleteRoute = imessageDataRoutes.find(
  (route) => route.type === "DELETE" && route.path === "/api/imessage/contacts/:id"
);
const listRoute = imessageDataRoutes.find(
  (route) => route.type === "GET" && route.path === "/api/imessage/contacts"
);

if (!patchRoute?.handler || !deleteRoute?.handler || !listRoute?.handler) {
  throw new Error("iMessage contact handlers missing");
}

interface Captured {
  status?: number;
  body?: unknown;
}

interface ServiceCalls {
  updates: string[];
  deletes: string[];
  lists: number;
}

function mockRes(captured: Captured): RouteResponse {
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(data: unknown) {
      captured.body = data;
      return res;
    },
    send(data: unknown) {
      captured.body = data;
      return res;
    },
    end() {
      return res;
    },
  };
  return res;
}

function mockRuntime(calls: ServiceCalls): IAgentRuntime {
  return {
    getService: (key: string) => {
      if (key !== "imessage") return null;
      return {
        isConnected: () => true,
        getMessages: async () => [],
        getRecentMessages: async () => [],
        sendMessage: async () => ({ success: true }),
        getChats: async () => [],
        listAllContacts: async () => {
          calls.lists += 1;
          return [];
        },
        addContact: async () => "person-1",
        updateContact: async (id: string) => {
          calls.updates.push(id);
          return true;
        },
        deleteContact: async (id: string) => {
          calls.deletes.push(id);
          return true;
        },
      };
    },
  } as unknown as IAgentRuntime;
}

async function patchContact(url: string, calls: ServiceCalls): Promise<Captured> {
  const captured: Captured = {};
  await patchRoute.handler?.(
    { url, method: "PATCH", body: { firstName: "Ada" } } as RouteRequest,
    mockRes(captured),
    mockRuntime(calls)
  );
  return captured;
}

async function deleteContact(url: string, calls: ServiceCalls): Promise<Captured> {
  const captured: Captured = {};
  await deleteRoute.handler?.(
    { url, method: "DELETE" } as RouteRequest,
    mockRes(captured),
    mockRuntime(calls)
  );
  return captured;
}

describe("PATCH /api/imessage/contacts/:id encoding", () => {
  it("canonical id still reaches updateContact", async () => {
    const calls: ServiceCalls = { updates: [], deletes: [], lists: 0 };
    const captured = await patchContact("/api/imessage/contacts/ABCD-EFGH", calls);
    expect(captured.status).toBe(200);
    expect(calls.updates).toEqual(["ABCD-EFGH"]);
  });

  it("canonical percent-encoded hyphen still decodes before updateContact", async () => {
    const calls: ServiceCalls = { updates: [], deletes: [], lists: 0 };
    const captured = await patchContact("/api/imessage/contacts/ABCD%2DEFGH", calls);
    expect(captured.status).toBe(200);
    expect(calls.updates).toEqual(["ABCD-EFGH"]);
  });

  it("GET contacts list is untouched", async () => {
    const calls: ServiceCalls = { updates: [], deletes: [], lists: 0 };
    const captured: Captured = {};
    await listRoute.handler?.(
      { url: "/api/imessage/contacts", method: "GET" } as RouteRequest,
      mockRes(captured),
      mockRuntime(calls)
    );
    expect(captured.status).toBe(200);
    expect(calls.lists).toBe(1);
    expect(calls.updates).toEqual([]);
    expect(calls.deletes).toEqual([]);
  });

  it.each(["%", "%2", "%ZZ", "%E0%A4"])(
    "rejects malformed patch id %s with 400",
    async (token) => {
      const calls: ServiceCalls = { updates: [], deletes: [], lists: 0 };
      const captured = await patchContact(`/api/imessage/contacts/${token}`, calls);
      expect(captured.status).toBe(400);
      expect(captured.body).toEqual({
        error: {
          code: "bad_request",
          message: "Invalid contact id: malformed URL encoding",
        },
      });
      expect(calls.updates).toEqual([]);
    }
  );
});

describe("DELETE /api/imessage/contacts/:id encoding", () => {
  it("canonical id still reaches deleteContact", async () => {
    const calls: ServiceCalls = { updates: [], deletes: [], lists: 0 };
    const captured = await deleteContact("/api/imessage/contacts/ABCD-EFGH", calls);
    expect(captured.status).toBe(200);
    expect(calls.deletes).toEqual(["ABCD-EFGH"]);
  });

  it.each(["%", "%2", "%ZZ"])(
    "rejects malformed delete id %s with 400",
    async (token) => {
      const calls: ServiceCalls = { updates: [], deletes: [], lists: 0 };
      const captured = await deleteContact(`/api/imessage/contacts/${token}`, calls);
      expect(captured.status).toBe(400);
      expect(captured.body).toEqual({
        error: {
          code: "bad_request",
          message: "Invalid contact id: malformed URL encoding",
        },
      });
      expect(calls.deletes).toEqual([]);
    }
  );
});
