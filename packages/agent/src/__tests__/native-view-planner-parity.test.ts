/**
 * Proves native Contacts, Messages, and Phone reads cross the real registered
 * VIEWS boundary for text and voice while every native mutation is rejected
 * before mounted-view dispatch. Production capability unions key the actual
 * handlers, so the package typechecks also enforce complete classification.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChannelType, type Memory, type RoleGateRole } from "@elizaos/core";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const nativeBridge = vi.hoisted(() => ({
  listContacts: vi.fn(),
  createContact: vi.fn(),
  importVCard: vi.fn(),
  listMessages: vi.fn(),
  sendSms: vi.fn(),
  getSystemStatus: vi.fn(),
  requestRole: vi.fn(),
  getPhoneStatus: vi.fn(),
  listRecentCalls: vi.fn(),
  placeCall: vi.fn(),
  openDialer: vi.fn(),
  saveCallTranscript: vi.fn(),
}));

vi.mock("@elizaos/capacitor-contacts", () => ({
  Contacts: {
    listContacts: nativeBridge.listContacts,
    createContact: nativeBridge.createContact,
    importVCard: nativeBridge.importVCard,
  },
}));

vi.mock("@elizaos/capacitor-messages", () => ({
  Messages: {
    listMessages: nativeBridge.listMessages,
    sendSms: nativeBridge.sendSms,
  },
}));

vi.mock("@elizaos/capacitor-system", () => ({
  System: {
    getStatus: nativeBridge.getSystemStatus,
    requestRole: nativeBridge.requestRole,
  },
}));

vi.mock("@elizaos/capacitor-phone", () => ({
  Phone: {
    getStatus: nativeBridge.getPhoneStatus,
    listRecentCalls: nativeBridge.listRecentCalls,
    placeCall: nativeBridge.placeCall,
    openDialer: nativeBridge.openDialer,
    saveCallTranscript: nativeBridge.saveCallTranscript,
  },
}));

import { createViewsAction } from "@elizaos/plugin-app-control/actions/views";
import { interact as interactContacts } from "../../../../plugins/plugin-contacts/src/components/ContactsAppView.interact.ts";
import { appContactsPlugin } from "../../../../plugins/plugin-contacts/src/plugin.ts";
import { interact as interactMessages } from "../../../../plugins/plugin-messages/src/components/messages-interact.ts";
import { appMessagesPlugin } from "../../../../plugins/plugin-messages/src/plugin.ts";
import { interact as interactPhone } from "../../../../plugins/plugin-phone/src/components/phone-interact.ts";
import { appPhonePlugin } from "../../../../plugins/plugin-phone/src/plugin.ts";
import {
  registerPluginViews,
  unregisterPluginViews,
} from "../api/views-registry.ts";
import {
  handleViewsRoutes,
  resolveViewInteractResult,
} from "../api/views-routes.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const VIEW_CLIENT_ID = "native-view-parity-client";
const PLUGINS = [appContactsPlugin, appMessagesPlugin, appPhonePlugin];
const VIEW_INTERACTORS = {
  contacts: interactContacts,
  messages: interactMessages,
  phone: interactPhone,
} as const;

interface DispatchedInteraction {
  viewId: keyof typeof VIEW_INTERACTORS;
  capability: string;
  params?: Record<string, unknown>;
  result: unknown;
}

const dispatched: DispatchedInteraction[] = [];
let server: http.Server;
let priorPort: string | undefined;
let serverCallerRole: RoleGateRole = "OWNER";

function writeJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function startViewsServer(): Promise<http.Server> {
  const created = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const handled = await handleViewsRoutes({
        req: request,
        res: response,
        method: request.method ?? "GET",
        pathname: url.pathname,
        url,
        json: (_res, body, status = 200) => writeJson(response, status, body),
        error: (_res, message, status = 500) =>
          writeJson(response, status, { error: message }),
        broadcastWsToClientId: (clientId, payload) => {
          if (clientId !== VIEW_CLIENT_ID) return 0;
          const frame = payload as {
            type?: string;
            requestId?: string;
            viewId?: string;
            capability?: string;
            params?: Record<string, unknown>;
          };
          if (
            frame.type !== "view:interact" ||
            typeof frame.requestId !== "string" ||
            !(frame.viewId && Object.hasOwn(VIEW_INTERACTORS, frame.viewId)) ||
            typeof frame.capability !== "string"
          ) {
            return 0;
          }
          const viewId = frame.viewId as keyof typeof VIEW_INTERACTORS;
          void VIEW_INTERACTORS[viewId](frame.capability, frame.params).then(
            (result) => {
              dispatched.push({
                viewId,
                capability: frame.capability as string,
                params: frame.params,
                result,
              });
              resolveViewInteractResult({
                requestId: frame.requestId as string,
                success: true,
                result,
              });
            },
            (error: unknown) => {
              resolveViewInteractResult({
                requestId: frame.requestId as string,
                success: false,
                error: error instanceof Error ? error.message : String(error),
              });
            },
          );
          return 1;
        },
        callerAuthorization: { ok: true, role: serverCallerRole },
      });
      if (!handled && !response.headersSent) {
        writeJson(response, 404, { error: "Not found" });
      }
    })().catch((error: unknown) => {
      // error-policy:J1 the test HTTP boundary turns an unexpected route error
      // into a visible failure response consumed by the action under test.
      if (!response.headersSent) {
        writeJson(response, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  });
  return new Promise((resolve) => {
    created.listen(0, "127.0.0.1", () => resolve(created));
  });
}

function message(channelType: ChannelType, text: string): Memory {
  return {
    entityId: "native-view-agent",
    roomId: "native-view-room",
    agentId: "native-view-agent",
    content: {
      text,
      channelType,
      metadata: { viewClientId: VIEW_CLIENT_ID },
    },
  } as Memory;
}

async function invoke(
  channelType: ChannelType,
  view: string,
  capability: string,
  params?: Record<string, unknown>,
) {
  const action = createViewsAction({ hasOwnerAccess: async () => true });
  const result = await action.handler(
    { agentId: "native-view-agent", actions: [] } as never,
    message(channelType, `Use ${capability} on ${view}`),
    undefined,
    { action: "interact", view, capability, params },
  );
  if (!result) throw new Error("VIEWS returned no action result");
  return result;
}

beforeAll(async () => {
  priorPort = process.env.ELIZA_PORT;
  for (const plugin of PLUGINS) {
    await registerPluginViews(
      plugin,
      path.join(repoRoot, "plugins", plugin.name.replace("@elizaos/", "")),
    );
  }
  server = await startViewsServer();
  process.env.ELIZA_PORT = String((server.address() as AddressInfo).port);
});

beforeEach(() => {
  dispatched.length = 0;
  serverCallerRole = "OWNER";
  vi.clearAllMocks();
  nativeBridge.listContacts.mockResolvedValue({
    contacts: [
      {
        id: "contact-1",
        lookupKey: "ada",
        displayName: "Ada Lovelace",
        phoneNumbers: ["+15550100"],
        emailAddresses: ["ada@example.com"],
        starred: true,
      },
    ],
  });
  nativeBridge.listMessages.mockResolvedValue({
    messages: [
      {
        id: "message-1",
        threadId: "thread-1",
        address: "+15550200",
        body: "hello",
        date: 1_700_000_000_000,
        type: 1,
        read: false,
      },
    ],
  });
  nativeBridge.getSystemStatus.mockResolvedValue({
    packageName: "ai.eliza",
    roles: [
      {
        role: "sms",
        androidRole: "android.app.role.SMS",
        held: true,
        holders: ["ai.eliza"],
        available: true,
      },
    ],
  });
  nativeBridge.getPhoneStatus.mockResolvedValue({ ready: true });
  nativeBridge.listRecentCalls.mockResolvedValue({
    calls: [
      {
        id: "call-1",
        number: "+15550300",
        cachedName: "Grace Hopper",
        date: 1_700_000_100_000,
        durationSeconds: 42,
        type: "incoming",
        isNew: false,
        agentSummary: null,
        agentTranscript: null,
      },
    ],
  });
});

afterAll(async () => {
  for (const plugin of PLUGINS) unregisterPluginViews(plugin.name);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (priorPort === undefined) delete process.env.ELIZA_PORT;
  else process.env.ELIZA_PORT = priorPort;
});

describe.each([ChannelType.DM, ChannelType.VOICE_DM])(
  "native reads through VIEWS on %s",
  (channelType) => {
    it("validates parameters and returns all three mounted native results", async () => {
      const contacts = await invoke(channelType, "contacts", "list-contacts", {
        query: "Ada",
      });
      const messages = await invoke(channelType, "messages", "list-threads");
      const phone = await invoke(channelType, "phone", "phone-state", {
        number: "+1 (555) 0300",
      });

      expect([contacts.success, messages.success, phone.success]).toEqual([
        true,
        true,
        true,
      ]);
      expect(dispatched).toEqual([
        {
          viewId: "contacts",
          capability: "list-contacts",
          params: { query: "Ada" },
          result: {
            query: "Ada",
            count: 1,
            contacts: [
              {
                id: "contact-1",
                lookupKey: "ada",
                displayName: "Ada Lovelace",
                phoneNumbers: ["+15550100"],
                emailAddresses: ["ada@example.com"],
                starred: true,
              },
            ],
          },
        },
        {
          viewId: "messages",
          capability: "list-threads",
          params: undefined,
          result: {
            threads: [
              {
                id: "thread-1",
                address: "+15550200",
                messageCount: 1,
                unreadCount: 1,
                lastMessage: "hello",
                lastMessageAt: 1_700_000_000_000,
              },
            ],
            ownsSmsRole: true,
            smsRoleHolder: "ai.eliza",
          },
        },
        {
          viewId: "phone",
          capability: "phone-state",
          params: { number: "+1 (555) 0300" },
          result: {
            status: { ready: true },
            calls: [
              {
                id: "call-1",
                number: "+15550300",
                cachedName: "Grace Hopper",
                label: "Grace Hopper",
                date: 1_700_000_100_000,
                durationSeconds: 42,
                type: "incoming",
                isNew: false,
                agentSummary: null,
                agentTranscript: null,
              },
            ],
          },
        },
      ]);
      expect(nativeBridge.listContacts).toHaveBeenCalledWith({
        query: "Ada",
        limit: 2_147_483_647,
      });
      expect(nativeBridge.listMessages).toHaveBeenCalledWith({ limit: 500 });
      expect(nativeBridge.listRecentCalls).toHaveBeenCalledWith({
        limit: 2_147_483_647,
        number: "+15550300",
      });
    });
  },
);

it("keeps every classified native mutation outside planner dispatch", async () => {
  const mutations = [
    ["contacts", "create-contact"],
    ["contacts", "import-vcard"],
    ["messages", "send-sms"],
    ["messages", "request-sms-role"],
    ["phone", "place-call"],
    ["phone", "open-dialer"],
    ["phone", "save-call-transcript"],
  ] as const;

  for (const [view, capability] of mutations) {
    const result = await invoke(ChannelType.DM, view, capability);
    expect(result).toMatchObject({
      success: false,
      text: `Capability "${capability}" on view "${view}" requires direct human interaction.`,
      transcriptVisibility: "internal",
    });
  }

  expect(dispatched).toEqual([]);
  expect(nativeBridge.createContact).not.toHaveBeenCalled();
  expect(nativeBridge.importVCard).not.toHaveBeenCalled();
  expect(nativeBridge.sendSms).not.toHaveBeenCalled();
  expect(nativeBridge.requestRole).not.toHaveBeenCalled();
  expect(nativeBridge.placeCall).not.toHaveBeenCalled();
  expect(nativeBridge.openDialer).not.toHaveBeenCalled();
  expect(nativeBridge.saveCallTranscript).not.toHaveBeenCalled();
});

it("rejects every generic DOM/state bypass before mounted dispatch", async () => {
  const bypasses = [
    ["contacts", "agent-fill", { id: "contact-create-name", value: "Ada" }],
    ["contacts", "agent-click", { id: "contact-create-save" }],
    ["messages", "agent-fill", { id: "composer-body", value: "hello" }],
    ["messages", "agent-click", { id: "send-message" }],
    ["phone", "agent-click", { id: "place-call" }],
    ...(
      [
        "get-state",
        "get-text",
        "list-elements",
        "describe-element",
        "get-focus",
        "get-agent-state",
      ] as const
    ).flatMap((capability) =>
      (["contacts", "messages", "phone"] as const).map(
        (view) => [view, capability, undefined] as const,
      ),
    ),
  ] as const;

  for (const [view, capability, params] of bypasses) {
    const result = await invoke(ChannelType.DM, view, capability, params);
    expect(result.success).toBe(false);
    expect(result.text).toMatch(
      /requires direct human interaction|failed \(HTTP 403\)/,
    );
  }

  expect(dispatched).toEqual([]);
  expect(nativeBridge.createContact).not.toHaveBeenCalled();
  expect(nativeBridge.sendSms).not.toHaveBeenCalled();
  expect(nativeBridge.placeCall).not.toHaveBeenCalled();
});

it("returns typed failures when native role or phone status cannot be read", async () => {
  nativeBridge.getSystemStatus.mockRejectedValueOnce(
    new Error("ROLE_SERVICE_UNAVAILABLE"),
  );
  const messages = await invoke(ChannelType.DM, "messages", "list-threads");
  expect(messages.success).toBe(false);

  nativeBridge.getPhoneStatus.mockRejectedValueOnce(
    new Error("TELECOM_SERVICE_UNAVAILABLE"),
  );
  const phone = await invoke(ChannelType.VOICE_DM, "phone", "phone-state");
  expect(phone.success).toBe(false);
  expect(dispatched).toEqual([]);
});

it("denies USER callers at the real HTTP interaction boundary", async () => {
  serverCallerRole = "USER";
  const port = (server.address() as AddressInfo).port;

  for (const [view, capability] of [
    ["contacts", "list-contacts"],
    ["messages", "list-threads"],
    ["phone", "phone-state"],
  ] as const) {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/views/${view}/interact`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability }),
      },
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: `View "${view}" is not available to this caller`,
    });
  }

  expect(dispatched).toEqual([]);
  expect(nativeBridge.listContacts).not.toHaveBeenCalled();
  expect(nativeBridge.listMessages).not.toHaveBeenCalled();
  expect(nativeBridge.listRecentCalls).not.toHaveBeenCalled();
});

it("rejects a native contacts page that cannot prove completeness", async () => {
  nativeBridge.listContacts.mockResolvedValue({
    contacts: Object.assign([], { length: 2_147_483_647 }),
  });

  const result = await invoke(ChannelType.DM, "contacts", "list-contacts");
  expect(result.success).toBe(false);
  await expect(interactContacts("list-contacts")).rejects.toMatchObject({
    code: "NATIVE_CONTACTS_READ_INCOMPLETE",
    context: { limit: 2_147_483_647 },
  });
  expect(dispatched).toEqual([]);
  expect(nativeBridge.listContacts).toHaveBeenCalledWith({
    limit: 2_147_483_647,
  });
});

it("classifies the complete native capability inventory at registration", () => {
  const classified = PLUGINS.flatMap((plugin) =>
    (plugin.views ?? []).flatMap((view) =>
      (view.capabilities ?? []).map((capability) => ({
        view: view.id,
        id: capability.id,
        authority: capability.authority,
        minRole: view.roleGate?.minRole,
        surface: view.surface?.capabilities ?? [],
      })),
    ),
  );

  expect(classified.filter(({ authority }) => authority === undefined)).toEqual(
    [],
  );
  expect(classified.every(({ minRole }) => minRole === "ADMIN")).toBe(true);
  expect(classified.every(({ surface }) => surface.length === 0)).toBe(true);
  expect(
    classified
      .filter(({ authority }) => authority === "agent")
      .map(({ view, id }) => `${view}:${id}`),
  ).toEqual([
    "contacts:list-contacts",
    "messages:list-threads",
    "phone:phone-state",
  ]);
});
