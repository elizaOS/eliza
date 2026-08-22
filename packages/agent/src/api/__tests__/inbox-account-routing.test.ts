/**
 * Account-aware inbox dispatch tests the real HTTP route with the core
 * connector-account manager and in-memory policy storage. Connector delivery is
 * captured at the final runtime seam so rejected requests prove no send occurs.
 */
import type http from "node:http";
import {
  type AgentRuntime,
  type ConnectorAccount,
  type Content,
  getConnectorAccountManager,
  InMemoryConnectorAccountStorage,
  type RouteHelpers,
  type SendHandlerOutcome,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  handleInboxRoute,
  type InboxRouteCallerAuthorization,
  type InboxRouteState,
} from "../inbox-routes";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000b1" as UUID;

interface RouteResponse {
  body: Record<string, unknown>;
  status: number;
}

function account(
  id: string,
  overrides: Partial<ConnectorAccount> = {},
): ConnectorAccount {
  return {
    id,
    provider: "discord",
    role: "AGENT",
    purpose: ["messaging"],
    accessGate: "open",
    status: "connected",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

async function createHarness(options: {
  accounts?: ConnectorAccount[];
  body: Record<string, unknown>;
  configureStorage?: (
    storage: InMemoryConnectorAccountStorage,
  ) => void | Promise<void>;
  callerAuthorization?: InboxRouteCallerAuthorization;
  omitCallerAuthorization?: boolean;
  roomSource?: string;
  sendHandlers?: Map<string, unknown>;
  sendOutcome?: SendHandlerOutcome | undefined;
  returnUnconfirmedSend?: boolean;
}) {
  const sendMessageToTarget = vi.fn(
    async (_target: TargetInfo, _content: Content) =>
      options.returnUnconfirmedSend
        ? undefined
        : (options.sendOutcome ?? {
            kind: "delivered",
            receipt: {
              providerMessageIds: ["inbox-provider-message-1"],
              acceptedAt: 1_780_000_000_000,
              persistence: { status: "persisted", memoryIds: [] },
            },
            memories: [],
          }),
  );
  const logger = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const runtime = {
    agentId: AGENT_ID,
    getService: vi.fn(() => null),
    getRoom: vi.fn(async (roomId: UUID) =>
      roomId === ROOM_ID
        ? {
            id: ROOM_ID,
            channelId: "channel-1",
            serverId: "server-1",
            source:
              options.roomSource ??
              (typeof options.body.source === "string"
                ? options.body.source
                : "discord"),
          }
        : null,
    ),
    getMemories: vi.fn(async () => []),
    logger,
    sendHandlers:
      options.sendHandlers ??
      new Map([
        ["discord", vi.fn()],
        ["imessage", vi.fn()],
      ]),
    sendMessageToTarget,
  } as unknown as AgentRuntime;
  const storage = new InMemoryConnectorAccountStorage();
  for (const item of options.accounts ?? []) {
    await storage.upsertAccount(item);
  }
  await options.configureStorage?.(storage);
  getConnectorAccountManager(runtime, storage);

  let response: RouteResponse | undefined;
  const helpers: RouteHelpers = {
    error: (_res, message, status = 500) => {
      response = { body: { error: message }, status };
    },
    json: (_res, data, status = 200) => {
      response = {
        body: data as Record<string, unknown>,
        status,
      };
    },
    readJsonBody: async <T extends object>() => options.body as T,
  };

  const routeState: InboxRouteState = {
    runtime,
    ...(!options.omitCallerAuthorization
      ? {
          callerAuthorization: options.callerAuthorization ?? {
            ok: true,
            role: "OWNER",
          },
        }
      : {}),
  };
  const handled = await handleInboxRoute(
    { url: "/api/inbox/messages" } as http.IncomingMessage,
    {} as http.ServerResponse,
    "/api/inbox/messages",
    "POST",
    routeState,
    helpers,
  );
  if (!response) {
    throw new Error("inbox route did not respond");
  }
  return { handled, logger, response, runtime, sendMessageToTarget, storage };
}

function requestBody(overrides: Record<string, unknown> = {}) {
  return {
    roomId: ROOM_ID,
    source: "discord",
    text: "hello",
    ...overrides,
  };
}

describe("POST /api/inbox/messages connector account routing", () => {
  it("rejects a request with no resolved caller authority", async () => {
    const harness = await createHarness({
      accounts: [account("work")],
      body: requestBody({ accountId: "work" }),
      omitCallerAuthorization: true,
    });

    expect(harness.response).toMatchObject({
      status: 403,
      body: { code: "INBOX_CALLER_UNAUTHORIZED" },
    });
    expect(harness.sendMessageToTarget).not.toHaveBeenCalled();
  });

  it("rejects a caller below the authenticated USER tier", async () => {
    const harness = await createHarness({
      accounts: [account("work")],
      body: requestBody({ accountId: "work" }),
      callerAuthorization: { ok: true, role: "NONE" },
    });

    expect(harness.response).toMatchObject({
      status: 403,
      body: { code: "INBOX_CALLER_UNAUTHORIZED" },
    });
    expect(harness.sendMessageToTarget).not.toHaveBeenCalled();
  });

  it("stamps an explicitly validated account only onto TargetInfo", async () => {
    const harness = await createHarness({
      accounts: [account("work")],
      body: requestBody({ accountId: " work " }),
    });

    expect(harness.handled).toBe(true);
    expect(harness.response).toMatchObject({ status: 200, body: { ok: true } });
    expect(harness.sendMessageToTarget).toHaveBeenCalledOnce();
    expect(harness.sendMessageToTarget.mock.calls[0]?.[0]).toMatchObject({
      accountId: "work",
      channelId: "channel-1",
      roomId: ROOM_ID,
      source: "discord",
    });
    expect(harness.sendMessageToTarget.mock.calls[0]?.[1]).toEqual({
      agentVoiced: true,
      source: "discord",
      text: "hello",
    });
    expect(harness.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "work",
        mode: "explicit",
        source: "discord",
      }),
      "[InboxRoutes] connector account routing validated",
    );
  });

  it("allows an authenticated USER to send through an open agent account", async () => {
    const harness = await createHarness({
      accounts: [account("agent-work")],
      body: requestBody({ accountId: "agent-work" }),
      callerAuthorization: { ok: true, role: "USER", identityId: "machine-1" },
    });

    expect(harness.response.status).toBe(200);
    expect(harness.sendMessageToTarget.mock.calls[0]?.[0]).toMatchObject({
      accountId: "agent-work",
    });
  });

  it("requires OWNER authority for an open account owned by the user", async () => {
    const harness = await createHarness({
      accounts: [account("slack-owner", { provider: "slack", role: "OWNER" })],
      body: requestBody({ accountId: "slack-owner", source: "slack" }),
      callerAuthorization: { ok: true, role: "USER", identityId: "machine-1" },
      roomSource: "slack",
      sendHandlers: new Map([["slack\u0000slack-owner", vi.fn()]]),
    });

    expect(harness.response).toMatchObject({
      status: 403,
      body: { code: "INBOX_CONNECTOR_ACCOUNT_CALLER_UNAUTHORIZED" },
    });
    expect(harness.sendMessageToTarget).not.toHaveBeenCalled();
  });

  it("preserves legacy source-default dispatch when no accounts exist", async () => {
    const harness = await createHarness({ body: requestBody() });

    expect(harness.response.status).toBe(200);
    expect(harness.sendMessageToTarget).toHaveBeenCalledOnce();
    expect(harness.sendMessageToTarget.mock.calls[0]?.[0]).not.toHaveProperty(
      "accountId",
    );
  });

  it("requires a manager account for an account-scoped-only handler", async () => {
    const harness = await createHarness({
      body: requestBody(),
      sendHandlers: new Map([["discord\u0000unregistered", vi.fn()]]),
    });

    expect(harness.response).toMatchObject({
      status: 409,
      body: { code: "INBOX_CONNECTOR_ACCOUNT_REQUIRED" },
    });
    expect(harness.sendMessageToTarget).not.toHaveBeenCalled();
  });

  it("selects the sole usable account deterministically", async () => {
    const harness = await createHarness({
      accounts: [
        account("disabled", { status: "disabled" }),
        account("usable"),
      ],
      body: requestBody(),
    });

    expect(harness.response.status).toBe(200);
    expect(harness.sendMessageToTarget.mock.calls[0]?.[0]).toMatchObject({
      accountId: "usable",
    });
  });

  it("selects the only usable default when several accounts can send", async () => {
    const harness = await createHarness({
      accounts: [
        account("personal"),
        account("work", { metadata: { isDefault: true } }),
      ],
      body: requestBody(),
    });

    expect(harness.response.status).toBe(200);
    expect(harness.sendMessageToTarget.mock.calls[0]?.[0]).toMatchObject({
      accountId: "work",
    });
  });

  it.each([
    {
      name: "no default",
      accounts: [account("one"), account("two")],
    },
    {
      name: "multiple defaults",
      accounts: [
        account("one", { metadata: { isDefault: true } }),
        account("two", { metadata: { isDefault: true } }),
      ],
    },
  ])("rejects ambiguous accounts with $name", async ({ accounts }) => {
    const harness = await createHarness({ accounts, body: requestBody() });

    expect(harness.response).toMatchObject({
      status: 409,
      body: { code: "INBOX_CONNECTOR_ACCOUNT_AMBIGUOUS" },
    });
    expect(harness.sendMessageToTarget).not.toHaveBeenCalled();
    expect(harness.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "INBOX_CONNECTOR_ACCOUNT_AMBIGUOUS",
        source: "discord",
      }),
      "[InboxRoutes] connector account routing rejected",
    );
  });

  it("rejects a forged account id without invoking a connector", async () => {
    const harness = await createHarness({
      accounts: [account("real")],
      body: requestBody({ accountId: "forged" }),
    });

    expect(harness.response).toMatchObject({
      status: 404,
      body: { code: "INBOX_CONNECTOR_ACCOUNT_NOT_FOUND" },
    });
    expect(harness.sendMessageToTarget).not.toHaveBeenCalled();
  });

  it("requires the selector to match account.id, not an external alias", async () => {
    const harness = await createHarness({
      accounts: [account("real", { externalId: "external-alias" })],
      body: requestBody({ accountId: "external-alias" }),
    });

    expect(harness.response).toMatchObject({
      status: 404,
      body: { code: "INBOX_CONNECTOR_ACCOUNT_NOT_FOUND" },
    });
    expect(harness.sendMessageToTarget).not.toHaveBeenCalled();
  });

  it("rejects an exact account id belonging to another source", async () => {
    const harness = await createHarness({
      accounts: [account("shared-id", { provider: "slack" })],
      body: requestBody({ accountId: "shared-id" }),
    });

    expect(harness.response).toMatchObject({
      status: 409,
      body: {
        code: "INBOX_CONNECTOR_ACCOUNT_SOURCE_MISMATCH",
        context: { accountSource: "slack", requestedSource: "discord" },
      },
    });
    expect(harness.sendMessageToTarget).not.toHaveBeenCalled();
  });

  it("rejects a requested transport that does not match the room", async () => {
    const harness = await createHarness({
      accounts: [account("slack-work", { provider: "slack" })],
      body: requestBody({ accountId: "slack-work", source: "slack" }),
      roomSource: "discord",
      sendHandlers: new Map([["slack\u0000slack-work", vi.fn()]]),
    });

    expect(harness.response).toMatchObject({
      status: 409,
      body: {
        code: "INBOX_ROOM_SOURCE_MISMATCH",
        context: { requestedSource: "slack", roomSource: "discord" },
      },
    });
    expect(harness.sendMessageToTarget).not.toHaveBeenCalled();
  });

  it.each([
    account("disabled-status", { status: "disabled" }),
    account("disabled-metadata", { metadata: { disabled: true } }),
    account("not-messaging", { purpose: ["reading"] }),
    account("manual-approval", { accessGate: "manual_approval" }),
  ])("rejects unavailable account $id", async (unavailableAccount) => {
    const harness = await createHarness({
      accounts: [unavailableAccount],
      body: requestBody({ accountId: unavailableAccount.id }),
    });

    expect(harness.response).toMatchObject({
      status: 409,
      body: { code: "INBOX_CONNECTOR_ACCOUNT_UNAVAILABLE" },
    });
    expect(harness.sendMessageToTarget).not.toHaveBeenCalled();
  });

  it("rejects an owner account without a verified binding", async () => {
    const harness = await createHarness({
      accounts: [
        account("owner", {
          accessGate: "owner_binding",
          externalId: "owner-external",
          role: "OWNER",
        }),
      ],
      body: requestBody({ accountId: "owner" }),
    });

    expect(harness.response).toMatchObject({
      status: 403,
      body: { code: "INBOX_CONNECTOR_ACCOUNT_OWNER_BINDING_REQUIRED" },
    });
    expect(harness.sendMessageToTarget).not.toHaveBeenCalled();
  });

  it("allows an owner account after its server-side binding is verified", async () => {
    const harness = await createHarness({
      accounts: [
        account("owner", {
          accessGate: "owner_binding",
          externalId: "owner-external",
          role: "OWNER",
        }),
      ],
      body: requestBody({ accountId: "owner" }),
      callerAuthorization: {
        ok: true,
        role: "OWNER",
        identityId: "identity-1",
      },
      configureStorage: (storage) => {
        storage.upsertOwnerBindingForTest({
          id: "binding-1",
          identityId: "identity-1",
          connector: "discord",
          externalId: "owner-external",
          displayHandle: "owner",
          instanceId: "",
          verifiedAt: 1,
        });
      },
    });

    expect(harness.response.status).toBe(200);
    expect(harness.sendMessageToTarget.mock.calls[0]?.[0]).toMatchObject({
      accountId: "owner",
    });
  });

  it("rejects an owner-bound account belonging to another identity", async () => {
    const harness = await createHarness({
      accounts: [
        account("owner", {
          accessGate: "owner_binding",
          externalId: "owner-external",
          role: "OWNER",
        }),
      ],
      body: requestBody({ accountId: "owner" }),
      callerAuthorization: {
        ok: true,
        role: "OWNER",
        identityId: "different-identity",
      },
      configureStorage: (storage) => {
        storage.upsertOwnerBindingForTest({
          id: "binding-1",
          identityId: "identity-1",
          connector: "discord",
          externalId: "owner-external",
          displayHandle: "owner",
          instanceId: "",
          verifiedAt: 1,
        });
      },
    });

    expect(harness.response).toMatchObject({
      status: 403,
      body: { code: "INBOX_CONNECTOR_ACCOUNT_CALLER_UNAUTHORIZED" },
    });
    expect(harness.sendMessageToTarget).not.toHaveBeenCalled();
  });

  it("allows an identityless full-authority OWNER with a verified binding", async () => {
    const harness = await createHarness({
      accounts: [
        account("owner", {
          accessGate: "owner_binding",
          externalId: "owner-external",
          role: "OWNER",
        }),
      ],
      body: requestBody({ accountId: "owner" }),
      callerAuthorization: { ok: true, role: "OWNER" },
      configureStorage: (storage) => {
        storage.upsertOwnerBindingForTest({
          id: "binding-1",
          identityId: "identity-1",
          connector: "discord",
          externalId: "owner-external",
          displayHandle: "owner",
          instanceId: "",
          verifiedAt: 1,
        });
      },
    });

    expect(harness.response.status).toBe(200);
    expect(harness.sendMessageToTarget.mock.calls[0]?.[0]).toMatchObject({
      accountId: "owner",
    });
  });

  it("requires OWNER authority for an owner-bound account", async () => {
    const harness = await createHarness({
      accounts: [
        account("owner", {
          accessGate: "owner_binding",
          externalId: "owner-external",
          role: "OWNER",
        }),
      ],
      body: requestBody({ accountId: "owner" }),
      callerAuthorization: { ok: true, role: "USER", identityId: "identity-1" },
      configureStorage: (storage) => {
        storage.upsertOwnerBindingForTest({
          id: "binding-1",
          identityId: "identity-1",
          connector: "discord",
          externalId: "owner-external",
          displayHandle: "owner",
          instanceId: "",
          verifiedAt: 1,
        });
      },
    });

    expect(harness.response).toMatchObject({
      status: 403,
      body: { code: "INBOX_CONNECTOR_ACCOUNT_CALLER_UNAUTHORIZED" },
    });
    expect(harness.sendMessageToTarget).not.toHaveBeenCalled();
  });

  it("never treats Content.metadata as account routing authority", async () => {
    const harness = await createHarness({
      accounts: [account("forged")],
      body: requestBody({ metadata: { accountId: "forged" } }),
    });

    expect(harness.response.status).toBe(400);
    expect(harness.sendMessageToTarget).not.toHaveBeenCalled();
  });

  it("fails closed with a typed error when account lookup fails", async () => {
    const harness = await createHarness({
      body: requestBody(),
      configureStorage: (storage) => {
        storage.listAccounts = vi.fn(async () => {
          throw new Error("storage unavailable");
        });
      },
    });

    expect(harness.response).toMatchObject({
      status: 500,
      body: { code: "INBOX_CONNECTOR_ACCOUNT_LOOKUP_FAILED" },
    });
    expect(harness.sendMessageToTarget).not.toHaveBeenCalled();
    expect(harness.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: "storage unavailable",
        source: "discord",
      }),
      "[InboxRoutes] connector account lookup failed",
    );
  });
});
