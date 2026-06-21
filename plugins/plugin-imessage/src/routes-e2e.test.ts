/**
 * Route-level e2e for plugin-imessage (issue #8802).
 *
 * Boots the plugin's declared `Route[]` (`imessageSetupRoutes` +
 * `imessageDataRoutes`) through the real production dispatcher
 * (`tryHandleRuntimePluginRoute`) over a loopback `http.createServer` — so the
 * real auth gate, JSON body parsing, query/param parsing, and handler dispatch
 * all run. The only external dependencies (the `imessage` service and the
 * `connector-setup` service) are faked; there is no chat.db, no Messages.app,
 * and no macOS bridge involved.
 *
 * No mocked `json`/`error` helpers and no shape-only assertions: every check is
 * on a real HTTP response read back over `fetch`.
 *
 * The package-wide vitest setup file mocks `@elizaos/core` down to a handful of
 * symbols, which would strip the helpers the dispatcher imports
 * (`readRequestBodyBuffer`, `writeJsonError`, `isJsonObjectBody`,
 * `setRuntimeRouteHostContext`). This file restores the real module so the
 * dispatcher runs against production code.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", async () => await vi.importActual("@elizaos/core"));

import { tryHandleRuntimePluginRoute } from "../../../packages/agent/src/api/runtime-plugin-routes.ts";
import { imessageDataRoutes } from "./data-routes.ts";
import { imessageSetupRoutes } from "./setup-routes.ts";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        })
    )
  );
  servers.length = 0;
});

// ── Fakes for the two services the routes resolve ──────────────────────

interface SendResult {
  success: boolean;
  messageId?: string;
  chatId?: string;
  error?: string;
}

interface ImessageServiceCalls {
  sent: Array<{ to: string; text: string; mediaUrl?: string; maxBytes?: number }>;
  addContact: Array<Record<string, unknown>>;
  updateContact: Array<{ id: string; patch: Record<string, unknown> }>;
  deleteContact: string[];
}

interface ImessageServiceOverrides {
  connected?: boolean;
  status?: {
    available: boolean;
    connected: boolean;
    chatDbAvailable: boolean;
    sendOnly: boolean;
    chatDbPath: string;
    reason: string | null;
    permissionAction: {
      type: "full_disk_access";
      label: string;
      url: string;
      instructions: string[];
    } | null;
  };
  messages?: Array<{
    id: string;
    text: string;
    handle: string;
    chatId: string;
    timestamp: number;
    isFromMe: boolean;
    hasAttachments: boolean;
  }>;
  chats?: Array<{
    chatId: string;
    chatType: string;
    displayName?: string;
    participants: Array<{ handle: string; isPhoneNumber: boolean }>;
  }>;
  contacts?: Array<{
    id: string;
    name: string;
    firstName: string | null;
    lastName: string | null;
    phones: Array<{ label: string | null; value: string }>;
    emails: Array<{ label: string | null; value: string }>;
  }>;
  sendResult?: SendResult;
  addContactResult?: string | null;
  updateContactResult?: boolean;
  deleteContactResult?: boolean;
}

function makeImessageService(overrides: ImessageServiceOverrides, calls: ImessageServiceCalls) {
  return {
    isConnected: () => overrides.connected ?? false,
    getStatus: () => overrides.status,
    getRecentMessages: async () => overrides.messages ?? [],
    getMessages: async () => overrides.messages ?? [],
    sendMessage: async (
      to: string,
      text: string,
      options?: { mediaUrl?: string; maxBytes?: number }
    ): Promise<SendResult> => {
      calls.sent.push({
        to,
        text,
        mediaUrl: options?.mediaUrl,
        maxBytes: options?.maxBytes,
      });
      return overrides.sendResult ?? { success: true, messageId: "m-1", chatId: "c-1" };
    },
    getChats: async () => overrides.chats ?? [],
    listAllContacts: async () => overrides.contacts ?? [],
    addContact: async (input: Record<string, unknown>): Promise<string | null> => {
      calls.addContact.push(input);
      return overrides.addContactResult ?? "person-1";
    },
    updateContact: async (id: string, patch: Record<string, unknown>): Promise<boolean> => {
      calls.updateContact.push({ id, patch });
      return overrides.updateContactResult ?? true;
    },
    deleteContact: async (id: string): Promise<boolean> => {
      calls.deleteContact.push(id);
      return overrides.deleteContactResult ?? true;
    },
  };
}

interface ConnectorSetupCalls {
  config: Record<string, unknown>;
}

function makeConnectorSetupService(calls: ConnectorSetupCalls) {
  return {
    getConfig: () => calls.config,
    updateConfig: (updater: (config: Record<string, unknown>) => void) => {
      updater(calls.config);
    },
  };
}

interface RuntimeOptions {
  imessage?: ImessageServiceOverrides | null;
  connectorSetup?: ConnectorSetupCalls | null;
  calls?: ImessageServiceCalls;
}

function makeRuntime(options: RuntimeOptions = {}): AgentRuntime {
  const calls: ImessageServiceCalls = options.calls ?? {
    sent: [],
    addContact: [],
    updateContact: [],
    deleteContact: [],
  };
  const imessageService =
    options.imessage === null ? null : makeImessageService(options.imessage ?? {}, calls);
  const connectorSetupService =
    options.connectorSetup === null
      ? null
      : makeConnectorSetupService(options.connectorSetup ?? { config: {} });

  return {
    routes: [...imessageSetupRoutes, ...imessageDataRoutes],
    getService: (key: string) => {
      if (key === "imessage") return imessageService;
      if (key === "connector-setup") return connectorSetupService;
      return null;
    },
  } as unknown as AgentRuntime;
}

async function startServer(
  runtime: AgentRuntime,
  isAuthorized: () => boolean = () => true
): Promise<string> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await tryHandleRuntimePluginRoute({
      req,
      res,
      method: req.method ?? "GET",
      pathname: url.pathname,
      url,
      runtime,
      isAuthorized,
    });
    if (!handled && !res.headersSent) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function sendJson(base: string, method: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── Setup routes ──────────────────────────────────────────────────────

describe("plugin-imessage setup routes (real dispatch)", () => {
  it("GET /api/setup/imessage/status reports paired when the service is connected", async () => {
    const base = await startServer(
      makeRuntime({
        imessage: {
          connected: true,
          status: {
            available: true,
            connected: true,
            chatDbAvailable: true,
            sendOnly: false,
            chatDbPath: "/Users/test/Library/Messages/chat.db",
            reason: null,
            permissionAction: null,
          },
        },
      })
    );
    const res = await fetch(`${base}/api/setup/imessage/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connector: string;
      state: string;
      detail: { connected: boolean; chatDbAvailable: boolean };
    };
    expect(body.connector).toBe("imessage");
    expect(body.state).toBe("paired");
    expect(body.detail.connected).toBe(true);
    expect(body.detail.chatDbAvailable).toBe(true);
  });

  it("GET /api/setup/imessage/status reports idle when the service is not registered", async () => {
    const base = await startServer(makeRuntime({ imessage: null }));
    const res = await fetch(`${base}/api/setup/imessage/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: string;
      detail: { available: boolean; reason: string };
    };
    expect(body.state).toBe("idle");
    expect(body.detail.available).toBe(false);
    expect(body.detail.reason).toContain("not registered");
  });

  it("POST /api/setup/imessage/start enables the connector via connector-setup", async () => {
    const setup: ConnectorSetupCalls = { config: {} };
    const base = await startServer(
      makeRuntime({ connectorSetup: setup, imessage: { connected: false } })
    );
    const res = await sendJson(base, "POST", "/api/setup/imessage/start", {});
    expect(res.status).toBe(200);
    const connectors = setup.config.connectors as Record<string, { enabled: boolean }> | undefined;
    expect(connectors?.imessage.enabled).toBe(true);
  });

  it("POST /api/setup/imessage/start returns 503 when connector-setup is unavailable", async () => {
    const base = await startServer(makeRuntime({ connectorSetup: null }));
    const res = await sendJson(base, "POST", "/api/setup/imessage/start", {});
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("service_unavailable");
    expect(body.error.message).toContain("connector-setup");
  });

  it("POST /api/setup/imessage/cancel clears the connector block", async () => {
    const setup: ConnectorSetupCalls = {
      config: { connectors: { imessage: { enabled: true } } },
    };
    const base = await startServer(makeRuntime({ connectorSetup: setup }));
    const res = await sendJson(base, "POST", "/api/setup/imessage/cancel", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connector: string; state: string };
    expect(body.state).toBe("idle");
    const connectors = setup.config.connectors as Record<string, unknown>;
    expect(connectors.imessage).toBeUndefined();
  });

  it("enforces the auth gate on the non-public setup status route", async () => {
    const base = await startServer(makeRuntime({ imessage: { connected: true } }), () => false);
    const res = await fetch(`${base}/api/setup/imessage/status`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("Unauthorized");
  });
});

// ── Data routes ───────────────────────────────────────────────────────

describe("plugin-imessage data routes (real dispatch)", () => {
  it("GET /api/imessage/messages returns the service's messages and count", async () => {
    const base = await startServer(
      makeRuntime({
        imessage: {
          messages: [
            {
              id: "1",
              text: "hi",
              handle: "+15550001111",
              chatId: "chat-1",
              timestamp: 1,
              isFromMe: false,
              hasAttachments: false,
            },
          ],
        },
      })
    );
    const res = await fetch(`${base}/api/imessage/messages?limit=10`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ id: string }>;
      count: number;
    };
    expect(body.count).toBe(1);
    expect(body.messages[0].id).toBe("1");
  });

  it("POST /api/imessage/messages sends a message on valid input", async () => {
    const calls: ImessageServiceCalls = {
      sent: [],
      addContact: [],
      updateContact: [],
      deleteContact: [],
    };
    const base = await startServer(makeRuntime({ imessage: { connected: true }, calls }));
    const res = await sendJson(base, "POST", "/api/imessage/messages", {
      to: "+15550001111",
      text: "hello there",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; messageId?: string };
    expect(body.success).toBe(true);
    expect(calls.sent).toHaveLength(1);
    expect(calls.sent[0]).toMatchObject({ to: "+15550001111", text: "hello there" });
  });

  it("POST /api/imessage/messages rejects a body missing both to and chatId with 400", async () => {
    const base = await startServer(makeRuntime({ imessage: { connected: true } }));
    const res = await sendJson(base, "POST", "/api/imessage/messages", {
      text: "no recipient",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain("to or chatId");
  });

  it("POST /api/imessage/messages rejects a body missing both text and mediaUrl with 400", async () => {
    const base = await startServer(makeRuntime({ imessage: { connected: true } }));
    const res = await sendJson(base, "POST", "/api/imessage/messages", {
      to: "+15550001111",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      "text or mediaUrl"
    );
  });

  it("GET /api/imessage/messages returns 503 when the imessage service is unavailable", async () => {
    const base = await startServer(makeRuntime({ imessage: null }));
    const res = await fetch(`${base}/api/imessage/messages`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("service_unavailable");
    expect(body.error.message).toContain("imessage service not registered");
  });

  it("GET /api/imessage/chats returns chats and count", async () => {
    const base = await startServer(
      makeRuntime({
        imessage: {
          chats: [
            {
              chatId: "chat-1",
              chatType: "dm",
              participants: [{ handle: "+15550001111", isPhoneNumber: true }],
            },
          ],
        },
      })
    );
    const res = await fetch(`${base}/api/imessage/chats`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chats: unknown[]; count: number };
    expect(body.count).toBe(1);
  });

  it("GET /api/imessage/contacts returns contacts and count", async () => {
    const base = await startServer(
      makeRuntime({
        imessage: {
          contacts: [
            {
              id: "p1",
              name: "Ada",
              firstName: "Ada",
              lastName: null,
              phones: [{ label: null, value: "+15550001111" }],
              emails: [],
            },
          ],
        },
      })
    );
    const res = await fetch(`${base}/api/imessage/contacts`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contacts: unknown[]; count: number };
    expect(body.count).toBe(1);
  });

  it("POST /api/imessage/contacts creates a contact and returns 201", async () => {
    const calls: ImessageServiceCalls = {
      sent: [],
      addContact: [],
      updateContact: [],
      deleteContact: [],
    };
    const base = await startServer(makeRuntime({ imessage: {}, calls }));
    const res = await sendJson(base, "POST", "/api/imessage/contacts", {
      firstName: "Grace",
      lastName: "Hopper",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; created: boolean };
    expect(body.created).toBe(true);
    expect(body.id).toBe("person-1");
    expect(calls.addContact).toHaveLength(1);
  });

  it("POST /api/imessage/contacts rejects an empty contact body with 400", async () => {
    const base = await startServer(makeRuntime({ imessage: {} }));
    const res = await sendJson(base, "POST", "/api/imessage/contacts", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain("at least one of");
  });

  it("PATCH /api/imessage/contacts/:id updates the addressed contact", async () => {
    const calls: ImessageServiceCalls = {
      sent: [],
      addContact: [],
      updateContact: [],
      deleteContact: [],
    };
    const base = await startServer(makeRuntime({ imessage: {}, calls }));
    const res = await sendJson(base, "PATCH", "/api/imessage/contacts/ABCD-1234", {
      firstName: "Renamed",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; updated: boolean };
    expect(body.updated).toBe(true);
    expect(body.id).toBe("ABCD-1234");
    expect(calls.updateContact[0].id).toBe("ABCD-1234");
  });

  it("DELETE /api/imessage/contacts/:id deletes the addressed contact", async () => {
    const calls: ImessageServiceCalls = {
      sent: [],
      addContact: [],
      updateContact: [],
      deleteContact: [],
    };
    const base = await startServer(makeRuntime({ imessage: {}, calls }));
    const res = await fetch(`${base}/api/imessage/contacts/ABCD-1234`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; deleted: boolean };
    expect(body.deleted).toBe(true);
    expect(calls.deleteContact).toEqual(["ABCD-1234"]);
  });

  it("enforces the auth gate on the non-public data routes", async () => {
    const base = await startServer(makeRuntime({ imessage: { connected: true } }), () => false);
    const res = await fetch(`${base}/api/imessage/messages`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("Unauthorized");
  });
});
