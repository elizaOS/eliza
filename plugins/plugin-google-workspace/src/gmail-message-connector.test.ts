/**
 * Unit coverage for the Gmail send MessageConnector: provider wire-up
 * (registering the Google connector-account provider registers a `gmail` send
 * connector, closing the SOURCE_CONNECTOR_NOT_FOUND gap), literal-address and
 * entity-handle recipient resolution, account selection, subject derivation,
 * and the structural delivery receipt. Mock runtime and Google service stubs —
 * no live Gmail API, nothing is actually sent.
 */
import {
  CONNECTOR_ACCOUNT_SERVICE_TYPE,
  type ConnectorAccount,
  ConnectorAccountManager,
  type Content,
  getConnectorAccountManager,
  type IAgentRuntime,
  InMemoryConnectorAccountStorage,
  type MessageConnectorRegistration,
  type SendHandlerOutcome,
  type TargetInfo,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createGoogleConnectorAccountProvider } from "./connector-account-provider.js";
import {
  createGmailMessageConnector,
  GMAIL_MESSAGE_SOURCE,
  isEmailAddress,
} from "./gmail-message-connector.js";
import { GOOGLE_SERVICE_NAME } from "./types.js";

const SHADOW_ID = "00000000-0000-0000-0000-0000000000e7";

type AccountStub = {
  id: string;
  status: string;
  displayHandle?: string;
  metadata?: Record<string, unknown>;
};

function runtimeStub(options: {
  accounts?: AccountStub[];
  sendGmailMessage?: ReturnType<typeof vi.fn>;
  entity?: { id: string; names: string[]; components?: Array<Record<string, unknown>> };
}): {
  runtime: IAgentRuntime;
  sendGmailMessage: ReturnType<typeof vi.fn>;
} {
  const sendGmailMessage =
    options.sendGmailMessage ??
    vi.fn(async () => ({ messageId: "sent_1", threadId: "thread_1", labelIds: ["SENT"] }));
  const accountManager = {
    registerProvider: vi.fn(),
    evaluatePolicy: vi.fn(async (policy, context: { accountId?: string }) => {
      const account = (options.accounts ?? []).find(
        (candidate) => candidate.id === context.accountId
      );
      const allowed = account?.status === "connected";
      return {
        allowed,
        provider: "google",
        account: allowed ? (account as unknown as ConnectorAccount) : undefined,
        policy,
      };
    }),
    listAccounts: vi.fn(async () => options.accounts ?? []),
    getAccount: vi.fn(
      async (_provider: string, accountId: string) =>
        (options.accounts ?? []).find((account) => account.id === accountId) ?? null
    ),
  };
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001",
    getService: vi.fn((serviceType: string) => {
      if (serviceType === "google") return { sendGmailMessage };
      if (serviceType === CONNECTOR_ACCOUNT_SERVICE_TYPE) return accountManager;
      return null;
    }),
    getEntityById: vi.fn(async (id: string) =>
      options.entity && id === options.entity.id ? options.entity : null
    ),
  } as unknown as IAgentRuntime;
  return { runtime, sendGmailMessage };
}

async function runtimeWithRealAccountPolicy(options: {
  accessGate: ConnectorAccount["accessGate"];
  verifiedOwner?: boolean;
}): Promise<{
  runtime: IAgentRuntime;
  sendGmailMessage: ReturnType<typeof vi.fn>;
}> {
  const storage = new InMemoryConnectorAccountStorage();
  const account: ConnectorAccount = {
    id: "acct_policy",
    provider: "google",
    role: options.accessGate === "owner_binding" ? "OWNER" : "AGENT",
    purpose: ["messaging"],
    accessGate: options.accessGate,
    status: "connected",
    externalId: "google/user@example.com",
    displayHandle: "user@example.com",
    createdAt: 1,
    updatedAt: 1,
    metadata: { grantedCapabilities: ["gmail.send"] },
  };
  await storage.upsertAccount(account);
  if (options.verifiedOwner) {
    storage.upsertOwnerBindingForTest({
      id: "binding-1",
      identityId: "00000000-0000-0000-0000-0000000000cc",
      connector: "google",
      externalId: account.externalId as string,
      displayHandle: account.displayHandle as string,
      instanceId: "",
      verifiedAt: 2,
    });
  }
  const manager = new ConnectorAccountManager(undefined, storage);
  const sendGmailMessage = vi.fn(async () => ({
    messageId: "sent_policy",
    threadId: "thread_policy",
  }));
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001",
    getService: vi.fn((serviceType: string) => {
      if (serviceType === GOOGLE_SERVICE_NAME) return { sendGmailMessage };
      if (serviceType === CONNECTOR_ACCOUNT_SERVICE_TYPE) return manager;
      return null;
    }),
  } as unknown as IAgentRuntime;
  return { runtime, sendGmailMessage };
}

async function invokeSend(
  registration: MessageConnectorRegistration,
  runtime: IAgentRuntime,
  target: Partial<TargetInfo>,
  content: Content
): Promise<SendHandlerOutcome> {
  if (!registration.sendHandler) throw new Error("sendHandler missing");
  const result = await registration.sendHandler(
    runtime,
    { source: GMAIL_MESSAGE_SOURCE, ...target } as TargetInfo,
    content
  );
  if (!result || !("kind" in result)) {
    throw new Error("sendHandler must return a structural outcome");
  }
  return result as SendHandlerOutcome;
}

const CONNECTED_ACCOUNT: AccountStub = {
  id: "acct_google_1",
  status: "connected",
  displayHandle: "owner@example.com",
  metadata: { grantedCapabilities: ["gmail.read", "gmail.send"] },
};

describe("gmail send connector wire-up", () => {
  it("registering the Google provider registers gmail as a send-target MessageConnector", () => {
    const registered: MessageConnectorRegistration[] = [];
    const managerRuntime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      getService: () => null,
      getMessageConnectors: () => [],
      getPostConnectors: () => [],
      registerMessageConnector: (registration: MessageConnectorRegistration) => {
        registered.push(registration);
      },
    } as unknown as IAgentRuntime;

    const provider = createGoogleConnectorAccountProvider(managerRuntime);
    const result = getConnectorAccountManager(managerRuntime).registerProvider(provider);

    // This is the seam that used to be missing: without a registered gmail
    // send connector, MESSAGE op=send source=gmail failed with
    // SOURCE_CONNECTOR_NOT_FOUND before any Gmail code ran.
    expect(result.messageConnectorRegistered).toBe(true);
    expect(registered).toHaveLength(1);
    expect(registered[0].source).toBe(GMAIL_MESSAGE_SOURCE);
    expect(typeof registered[0].sendHandler).toBe("function");

    // The registration advertises the shapes MESSAGE op=send resolves against:
    // "email"-kind targets and the email/mail source aliases.
    expect(registered[0].supportedTargetKinds).toContain("email");
    expect((registered[0].metadata as { aliases?: string[] } | undefined)?.aliases).toContain(
      "email"
    );
  });

  it("resolveTargets treats a literal email address as an unambiguous target", async () => {
    const registration = createGmailMessageConnector(runtimeStub({}).runtime);
    if (!registration.resolveTargets) throw new Error("resolveTargets missing");
    const context = { runtime: runtimeStub({}).runtime } as never;

    const hits = await registration.resolveTargets("shadow@example.com", context);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      kind: "email",
      label: "shadow@example.com",
      target: { source: GMAIL_MESSAGE_SOURCE, channelId: "shadow@example.com" },
    });

    await expect(registration.resolveTargets("shadow", context)).resolves.toEqual([]);
  });
});

describe("gmail send handler", () => {
  it("sends to a literal address through the sole connected gmail-send account", async () => {
    const { runtime, sendGmailMessage } = runtimeStub({
      accounts: [CONNECTED_ACCOUNT],
    });
    const registration = createGmailMessageConnector(runtime);

    const outcome = await invokeSend(
      registration,
      runtime,
      { channelId: "shadow@example.com" },
      { text: "Please stop smoking.", metadata: { subject: "A friendly reminder" } }
    );

    expect(sendGmailMessage).toHaveBeenCalledWith({
      accountId: "acct_google_1",
      to: ["shadow@example.com"],
      subject: "A friendly reminder",
      bodyText: "Please stop smoking.",
    });
    expect(outcome).toMatchObject({
      kind: "delivered",
      receipt: {
        providerMessageIds: ["sent_1"],
        persistence: { status: "not_attempted" },
      },
    });
  });

  it("derives the subject from the first body line when none is supplied", async () => {
    const { runtime, sendGmailMessage } = runtimeStub({
      accounts: [CONNECTED_ACCOUNT],
    });
    const registration = createGmailMessageConnector(runtime);

    await invokeSend(
      registration,
      runtime,
      { channelId: "shadow@example.com" },
      { text: "Stop smoking\nIt is bad for you." }
    );

    expect(sendGmailMessage).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Stop smoking" })
    );
  });

  it("resolves an entity-store recipient through stored email handles", async () => {
    const { runtime, sendGmailMessage } = runtimeStub({
      accounts: [CONNECTED_ACCOUNT],
      entity: {
        id: SHADOW_ID,
        names: ["Shadow"],
        components: [
          { type: "discord", data: { channelId: "dm-1" } },
          { type: "contact_info", data: { email: "shadow@example.com" } },
        ],
      },
    });
    const registration = createGmailMessageConnector(runtime);

    const outcome = await invokeSend(
      registration,
      runtime,
      { entityId: SHADOW_ID as TargetInfo["entityId"] },
      { text: "hello" }
    );

    expect(outcome.kind).toBe("delivered");
    expect(sendGmailMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: ["shadow@example.com"] })
    );
  });

  it("honors an explicit target accountId when it is connected and send-capable", async () => {
    const { runtime, sendGmailMessage } = runtimeStub({
      accounts: [{ ...CONNECTED_ACCOUNT, id: "acct_explicit" }],
    });
    const registration = createGmailMessageConnector(runtime);

    const outcome = await invokeSend(
      registration,
      runtime,
      { channelId: "shadow@example.com", accountId: "acct_explicit" },
      { text: "hello" }
    );

    expect(outcome.kind).toBe("delivered");
    expect(sendGmailMessage).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct_explicit" })
    );
  });

  it.each<[string, AccountStub[]]>([
    ["missing", []],
    [
      "disconnected",
      [
        {
          id: "acct_explicit",
          status: "disabled",
          metadata: { grantedCapabilities: ["gmail.send"] },
        },
      ],
    ],
    [
      "read-only",
      [
        {
          id: "acct_explicit",
          status: "connected",
          metadata: { grantedCapabilities: ["gmail.read"] },
        },
      ],
    ],
  ])("rejects an explicit accountId when it is %s", async (_case, accounts) => {
    const { runtime, sendGmailMessage } = runtimeStub({
      accounts,
    });
    const registration = createGmailMessageConnector(runtime);

    const outcome = await invokeSend(
      registration,
      runtime,
      { channelId: "shadow@example.com", accountId: "acct_explicit" },
      { text: "hello" }
    );

    expect(outcome).toMatchObject({
      kind: "not_delivered",
      code: "GMAIL_ACCOUNT_UNAVAILABLE",
    });
    expect(sendGmailMessage).not.toHaveBeenCalled();
  });

  it.each(["owner_binding", "manual_approval", "disabled"] as const)(
    "rejects a send-capable explicit account behind an unauthorized %s gate",
    async (accessGate) => {
      const { runtime, sendGmailMessage } = await runtimeWithRealAccountPolicy({
        accessGate,
      });
      const registration = createGmailMessageConnector(runtime);

      const outcome = await invokeSend(
        registration,
        runtime,
        { channelId: "shadow@example.com", accountId: "acct_policy" },
        { text: "hello" }
      );

      expect(outcome).toMatchObject({
        kind: "not_delivered",
        code: "GMAIL_ACCOUNT_UNAVAILABLE",
      });
      expect(sendGmailMessage).not.toHaveBeenCalled();
    }
  );

  it("allows a send-capable owner account after its binding is verified", async () => {
    const { runtime, sendGmailMessage } = await runtimeWithRealAccountPolicy({
      accessGate: "owner_binding",
      verifiedOwner: true,
    });
    const registration = createGmailMessageConnector(runtime);

    const outcome = await invokeSend(
      registration,
      runtime,
      { channelId: "shadow@example.com", accountId: "acct_policy" },
      { text: "hello" }
    );

    expect(outcome.kind).toBe("delivered");
    expect(sendGmailMessage).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct_policy" })
    );
  });

  it("excludes an unverified owner account from implicit account discovery", async () => {
    const { runtime, sendGmailMessage } = await runtimeWithRealAccountPolicy({
      accessGate: "owner_binding",
    });
    const registration = createGmailMessageConnector(runtime);

    const outcome = await invokeSend(
      registration,
      runtime,
      { channelId: "shadow@example.com" },
      { text: "hello" }
    );

    expect(outcome).toMatchObject({
      kind: "not_delivered",
      code: "GMAIL_ACCOUNT_UNAVAILABLE",
    });
    expect(sendGmailMessage).not.toHaveBeenCalled();
  });

  it("refuses structurally when no connected account can send", async () => {
    const { runtime, sendGmailMessage } = runtimeStub({
      accounts: [
        {
          id: "acct_readonly",
          status: "connected",
          metadata: { grantedCapabilities: ["gmail.read"] },
        },
      ],
    });
    const registration = createGmailMessageConnector(runtime);

    const outcome = await invokeSend(
      registration,
      runtime,
      { channelId: "shadow@example.com" },
      { text: "hello" }
    );

    expect(outcome).toMatchObject({
      kind: "not_delivered",
      code: "GMAIL_ACCOUNT_UNAVAILABLE",
    });
    expect(sendGmailMessage).not.toHaveBeenCalled();
  });

  it("refuses structurally when the account choice is ambiguous", async () => {
    const { runtime, sendGmailMessage } = runtimeStub({
      accounts: [CONNECTED_ACCOUNT, { ...CONNECTED_ACCOUNT, id: "acct_google_2" }],
    });
    const registration = createGmailMessageConnector(runtime);

    const outcome = await invokeSend(
      registration,
      runtime,
      { channelId: "shadow@example.com" },
      { text: "hello" }
    );

    expect(outcome).toMatchObject({
      kind: "not_delivered",
      code: "GMAIL_ACCOUNT_AMBIGUOUS",
    });
    expect(sendGmailMessage).not.toHaveBeenCalled();
  });

  it("refuses structurally when the contact has multiple distinct stored emails", async () => {
    const { runtime, sendGmailMessage } = runtimeStub({
      accounts: [CONNECTED_ACCOUNT],
      entity: {
        id: SHADOW_ID,
        names: ["Shadow"],
        components: [
          { type: "contact_info", data: { email: "shadow.work@example.com" } },
          { type: "rolodex", data: { email: "shadow.personal@example.com" } },
        ],
      },
    });
    const registration = createGmailMessageConnector(runtime);

    const outcome = await invokeSend(
      registration,
      runtime,
      { entityId: SHADOW_ID as TargetInfo["entityId"] },
      { text: "hello" }
    );

    expect(outcome).toMatchObject({
      kind: "not_delivered",
      code: "GMAIL_RECIPIENT_AMBIGUOUS",
    });
    expect(sendGmailMessage).not.toHaveBeenCalled();
  });

  it("ignores email-shaped values in unrelated fields when a named email field exists", async () => {
    const { runtime, sendGmailMessage } = runtimeStub({
      accounts: [CONNECTED_ACCOUNT],
      entity: {
        id: SHADOW_ID,
        names: ["Shadow"],
        components: [
          { type: "notes", data: { assistant: "third.party@example.com" } },
          { type: "contact_info", data: { email: "shadow@example.com" } },
        ],
      },
    });
    const registration = createGmailMessageConnector(runtime);

    const outcome = await invokeSend(
      registration,
      runtime,
      { entityId: SHADOW_ID as TargetInfo["entityId"] },
      { text: "hello" }
    );

    expect(outcome.kind).toBe("delivered");
    expect(sendGmailMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: ["shadow@example.com"] })
    );
  });

  it("refuses structurally when no recipient email can be resolved", async () => {
    const { runtime, sendGmailMessage } = runtimeStub({
      accounts: [CONNECTED_ACCOUNT],
    });
    const registration = createGmailMessageConnector(runtime);

    const outcome = await invokeSend(
      registration,
      runtime,
      { entityId: "shadow" as TargetInfo["entityId"] },
      { text: "hello" }
    );

    expect(outcome).toMatchObject({
      kind: "not_delivered",
      code: "GMAIL_RECIPIENT_UNRESOLVED",
    });
    expect(sendGmailMessage).not.toHaveBeenCalled();
  });
});

describe("isEmailAddress", () => {
  it("accepts literal addresses and rejects names/handles", () => {
    expect(isEmailAddress("shadow@example.com")).toBe(true);
    expect(isEmailAddress("  shadow@example.com  ")).toBe(true);
    expect(isEmailAddress("shadow")).toBe(false);
    expect(isEmailAddress("@shadow")).toBe(false);
    expect(isEmailAddress("shadow@localhost")).toBe(false);
    expect(isEmailAddress(42)).toBe(false);
  });
});
