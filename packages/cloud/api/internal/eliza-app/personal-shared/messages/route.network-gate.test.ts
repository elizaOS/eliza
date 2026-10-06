/**
 * Proves The Network's invite gate runs before personal account resolution:
 * an uninvited phone gets the canned reply and never reaches the account
 * auto-creation path, Network group chats are dropped silently, and every
 * other project bypasses the gate without consulting the invite store.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  InMemoryNetworkInviteStore,
  NETWORK_INVITE_REQUIRED_REPLY,
} from "@/lib/network/inbound-gate";

const inviteStore = new InMemoryNetworkInviteStore();
const accountResolutions: unknown[] = [];

class AccountResolutionReached extends Error {
  override readonly name = "AccountResolutionReached";
}

mock.module("@/lib/network/invite-lookup", () => ({
  networkInviteLookup: inviteStore,
  createPostgresNetworkInviteLookup: () => inviteStore,
}));

/** Phones whose projection returns an account instead of the sentinel error. */
const resolvedAccounts = new Map<
  string,
  { userId: string; organizationId: string }
>();
const links: unknown[] = [];
let linkResult: { kind: string; memberId?: string } = {
  kind: "linked",
  memberId: "member-1",
};

mock.module("@/lib/network/membership", () => ({
  networkMembership: {
    linkInvitedPhone: async (input: unknown) => {
      links.push(input);
      return linkResult;
    },
  },
}));

const actualProjection = await import("@/api-app/personal-delivery-projection");
mock.module("@/api-app/personal-delivery-projection", () => ({
  ...actualProjection,
  // Stands in for findOrCreatePhonePersonalAccount (users.ts): reaching it at
  // all is what the gate must prevent for an uninvited Network sender.
  resolvePersonalDeliveryProjection: async (
    _env: unknown,
    input: { phoneNumber?: string },
  ) => {
    accountResolutions.push(input);
    const account = input.phoneNumber
      ? resolvedAccounts.get(input.phoneNumber)
      : undefined;
    if (!account) {
      throw new AccountResolutionReached("account resolution reached");
    }
    return {
      ...account,
      resolution: "phone-query",
      dedicatedTarget: null,
      isNew: true,
    };
  },
}));

const { default: route } = await import("./route");

const INTERNAL_SECRET = "network-gate-test-secret";
const env = {
  INTERNAL_SECRET,
  SHARED_RUNTIME_CONVERSATIONS: { getByName: () => ({}) },
};
const executionCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};

async function deliver(body: Record<string, unknown>) {
  const response = await route.request(
    "/",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${INTERNAL_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    env,
    executionCtx as never,
  );
  return {
    status: response.status,
    body: (await response.json()) as {
      success: boolean;
      data?: { code?: string; reply?: string };
    },
  };
}

function phoneMessage(project: string, phoneNumber: string) {
  return {
    platform: "twilio",
    project,
    connectorAccountId: "+14155550000",
    phoneNumber,
    messageId: `twilio:${project}:SM${phoneNumber.slice(-4)}`,
    message: "hey, what is this?",
  };
}

describe("personal-shared route: Network invite gate", () => {
  beforeEach(() => {
    accountResolutions.length = 0;
    inviteStore.lookups.length = 0;
    links.length = 0;
    linkResult = { kind: "linked", memberId: "member-1" };
  });

  test("an uninvited Network phone gets the canned reply and no account is resolved", async () => {
    const { status, body } = await deliver(
      phoneMessage("network", "+14155550101"),
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: {
        code: "network_invite_required",
        reply: NETWORK_INVITE_REQUIRED_REPLY,
      },
    });
    expect(inviteStore.lookups).toEqual(["+14155550101"]);
    expect(accountResolutions).toHaveLength(0);
  });

  test("an invited Network phone passes the gate and reaches account resolution", async () => {
    inviteStore.accept("+14155550102");
    const { status } = await deliver(phoneMessage("network", "+14155550102"));
    expect(status).toBeGreaterThanOrEqual(500);
    expect(inviteStore.lookups).toEqual(["+14155550102"]);
    expect(accountResolutions).toEqual([
      { platform: "phone", phoneNumber: "+14155550102" },
    ]);
  });

  test("Network group chats are dropped silently before any lookup", async () => {
    const { status, body } = await deliver({
      platform: "blooio",
      chatType: "group",
      project: "network",
      connectorAccountId: "+14155550000",
      chatId: "chat_network_group",
      actor: { platformUserId: "+14155550103", role: "possessor" },
      messageId: "blooio:network:group-1",
      message: "hello group",
      invocation: "ambient",
    });
    expect(status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: { code: "network_group_unsupported", reply: "" },
    });
    expect(inviteStore.lookups).toHaveLength(0);
    expect(accountResolutions).toHaveLength(0);
  });

  test("a Network Telegram DM is refused without an account", async () => {
    const { body } = await deliver({
      platform: "telegram",
      project: "network",
      connectorAccountId: "bot:123",
      chatId: "42",
      telegramUserId: "42",
      messageId: "telegram:network:1",
      message: "hi",
    });
    expect(body.data?.code).toBe("network_invite_required");
    expect(accountResolutions).toHaveLength(0);
  });

  test("eliza-app traffic bypasses the gate and resolves the account as before", async () => {
    const { status } = await deliver(phoneMessage("eliza-app", "+14155550104"));
    expect(status).toBeGreaterThanOrEqual(500);
    expect(inviteStore.lookups).toHaveLength(0);
    expect(accountResolutions).toEqual([
      { platform: "phone", phoneNumber: "+14155550104" },
    ]);
  });

  test("the first admitted message accepts the invite and links the resolved account", async () => {
    inviteStore.accept("+14155550105");
    resolvedAccounts.set("+14155550105", {
      userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      organizationId: "6f9619ff-8b86-4011-b42d-00c04fc964ff",
    });
    await deliver(phoneMessage("network", "+14155550105"));
    expect(links).toEqual([
      {
        phoneE164: "+14155550105",
        cloudUserId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        organizationId: "6f9619ff-8b86-4011-b42d-00c04fc964ff",
      },
    ]);
  });

  test("an invite revoked between gate and link gets the canned reply", async () => {
    inviteStore.accept("+14155550106");
    resolvedAccounts.set("+14155550106", {
      userId: "00000000-0000-4000-8000-000000000006",
      organizationId: "00000000-0000-4000-8000-000000000007",
    });
    linkResult = { kind: "not_invited" };
    const { status, body } = await deliver(
      phoneMessage("network", "+14155550106"),
    );
    expect(status).toBe(200);
    expect(body.data).toEqual({
      code: "network_invite_required",
      reply: NETWORK_INVITE_REQUIRED_REPLY,
    });
  });

  test("eliza-app never links Network membership", async () => {
    resolvedAccounts.set("+14155550107", {
      userId: "00000000-0000-4000-8000-000000000008",
      organizationId: "00000000-0000-4000-8000-000000000009",
    });
    await deliver(phoneMessage("eliza-app", "+14155550107"));
    expect(links).toHaveLength(0);
  });

  test("Network group lifecycle events are refused without touching bindings", async () => {
    const base = {
      platform: "blooio",
      project: "network",
      connectorAccountId: "+14155550000",
      chatId: "chat_network_group",
      sourceMessageId: "blooio:network:group-2",
      leaseToken: "00000000-0000-4000-8000-00000000000a",
      authority: {
        bindingId: "00000000-0000-4000-8000-00000000000b",
        ownerUserId: "00000000-0000-4000-8000-00000000000c",
        personalAgentId: "personal:x",
        version: 1,
      },
    };
    const authorization = await deliver({
      ...base,
      eventType: "delivery_authorization",
      invocation: "mention",
    });
    expect(authorization.body.data).toMatchObject({
      code: "group_delivery_authorization",
      authorized: false,
    });
    const commit = await deliver({ ...base, eventType: "delivery_commit" });
    expect(commit.body.data).toMatchObject({ committed: false });
    const membership = await deliver({
      eventType: "membership",
      platform: "telegram",
      project: "network",
      connectorAccountId: "bot:123",
      chatId: "-100",
      messageId: "telegram:network:m1",
      membershipChange: "joined",
    });
    expect(membership.body.data).toEqual({
      code: "network_group_unsupported",
      reply: "",
    });
    expect(accountResolutions).toHaveLength(0);
  });
});
