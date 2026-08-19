/** Tests durable, authority-scoped in-app lifecycle acceptance and replay. */
// @vitest-environment jsdom

import type { AgentNotification } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../../api/client";
import {
  __resetLifecycleFollowUpConsumerForTests,
  consumeCloudLifecycleFollowUps,
} from "./lifecycle-follow-up-consumer";

const STORAGE_KEY_PREFIX = "elizaos:accepted-lifecycle-follow-ups:v2:";
const AUTHORITY_A = "https://cloud.test::user-a::session-a";
const AUTHORITY_B = "https://cloud.test::user-b::session-b";
const SESSION_ID = `lifecycle:${"a".repeat(48)}`;

function storageKey(authorityKey: string): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(authorityKey)}`;
}

function notice(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_ID,
    leaseId: "lease-1",
    message:
      "Your upgrade is complete and your personal workspace is ready. I can continue when you're back.",
    createdAt: "2026-08-19T12:00:00.000Z",
    expiresAt: "2099-08-26T12:00:00.000Z",
    lifecycleEvents: [
      {
        kind: "workspace_ready" as const,
        idempotencyKey: "workspace-ready:source-1",
        resourceId: "workspace-1",
      },
    ],
    ...overrides,
  };
}

describe("lifecycle follow-up consumer", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetLifecycleFollowUpConsumerForTests();
  });

  afterEach(() => vi.restoreAllMocks());

  it("acks only after durable storage and in-app acceptance", async () => {
    vi.spyOn(client, "claimCloudLifecycleFollowUps").mockResolvedValue({
      notices: [notice()],
    });
    const accept = vi.fn<(notification: AgentNotification) => void>();
    const ack = vi
      .spyOn(client, "acknowledgeCloudLifecycleFollowUps")
      .mockImplementation(async () => {
        expect(localStorage.getItem(storageKey(AUTHORITY_A))).toContain(
          SESSION_ID,
        );
        expect(accept).toHaveBeenCalledTimes(1);
        return { acknowledged: 1 };
      });

    await consumeCloudLifecycleFollowUps(AUTHORITY_A, accept);

    expect(ack).toHaveBeenCalledWith([
      { sessionId: SESSION_ID, leaseId: "lease-1" },
    ]);
    expect(accept.mock.calls[0]?.[0]).toMatchObject({
      title: "Workspace ready",
      body: notice().message,
      deepLink: "/chat",
      data: { continuationPolicy: "offer_only_never_auto_execute" },
    });
  });

  it("replays accepted state after a tab loss for the same authority", async () => {
    vi.spyOn(client, "claimCloudLifecycleFollowUps").mockResolvedValue({
      notices: [notice()],
    });
    vi.spyOn(client, "acknowledgeCloudLifecycleFollowUps").mockResolvedValue({
      acknowledged: 1,
    });
    const first: AgentNotification[] = [];
    await consumeCloudLifecycleFollowUps(AUTHORITY_A, (value) =>
      first.push(value),
    );

    __resetLifecycleFollowUpConsumerForTests();
    vi.mocked(client.claimCloudLifecycleFollowUps).mockResolvedValue({
      notices: [],
    });
    const restored: AgentNotification[] = [];
    await consumeCloudLifecycleFollowUps(AUTHORITY_A, (value) =>
      restored.push(value),
    );

    expect(restored).toHaveLength(1);
    expect(restored[0]?.id).toBe(first[0]?.id);
    expect(restored[0]?.groupKey).toBe(SESSION_ID);
  });

  it("leaves the server lease unacked when durable client storage fails", async () => {
    vi.spyOn(client, "claimCloudLifecycleFollowUps").mockResolvedValue({
      notices: [notice()],
    });
    const ack = vi.spyOn(client, "acknowledgeCloudLifecycleFollowUps");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const accept = vi.fn();

    await consumeCloudLifecycleFollowUps(AUTHORITY_A, accept);

    expect(accept).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });

  it("drops stale accepted state instead of rendering it after expiry", async () => {
    localStorage.setItem(
      storageKey(AUTHORITY_A),
      JSON.stringify([
        {
          acceptedAt: 1,
          notice: notice({ expiresAt: "2020-01-01T00:00:00.000Z" }),
        },
      ]),
    );
    vi.spyOn(client, "claimCloudLifecycleFollowUps").mockResolvedValue({
      notices: [],
    });
    const accept = vi.fn();

    await consumeCloudLifecycleFollowUps(AUTHORITY_A, accept);

    expect(accept).not.toHaveBeenCalled();
  });

  it("never replays account A accepted state after switching to account B", async () => {
    vi.spyOn(client, "claimCloudLifecycleFollowUps")
      .mockResolvedValueOnce({ notices: [notice()] })
      .mockResolvedValueOnce({ notices: [] });
    vi.spyOn(client, "acknowledgeCloudLifecycleFollowUps").mockResolvedValue({
      acknowledged: 1,
    });
    await consumeCloudLifecycleFollowUps(AUTHORITY_A, vi.fn());

    const accountB = vi.fn();
    await consumeCloudLifecycleFollowUps(AUTHORITY_B, accountB);

    expect(accountB).not.toHaveBeenCalled();
    expect(localStorage.getItem(storageKey(AUTHORITY_A))).toContain(SESSION_ID);
    expect(localStorage.getItem(storageKey(AUTHORITY_B))).toBeNull();
  });

  it("isolates logout and login sessions even for the same user and base", async () => {
    const reloggedAuthority = "https://cloud.test::user-a::session-new";
    vi.spyOn(client, "claimCloudLifecycleFollowUps")
      .mockResolvedValueOnce({ notices: [notice()] })
      .mockResolvedValueOnce({ notices: [] });
    vi.spyOn(client, "acknowledgeCloudLifecycleFollowUps").mockResolvedValue({
      acknowledged: 1,
    });
    await consumeCloudLifecycleFollowUps(AUTHORITY_A, vi.fn());

    __resetLifecycleFollowUpConsumerForTests();
    const relogged = vi.fn();
    await consumeCloudLifecycleFollowUps(reloggedAuthority, relogged);

    expect(relogged).not.toHaveBeenCalled();
    expect(localStorage.getItem(storageKey(reloggedAuthority))).toBeNull();
  });

  it("does not let an account A request block or populate account B", async () => {
    let resolveAccountA:
      | ((value: { notices: ReturnType<typeof notice>[] }) => void)
      | undefined;
    vi.spyOn(client, "claimCloudLifecycleFollowUps")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveAccountA = resolve;
          }),
      )
      .mockResolvedValueOnce({ notices: [] });
    vi.spyOn(client, "acknowledgeCloudLifecycleFollowUps").mockResolvedValue({
      acknowledged: 1,
    });
    const accountA = vi.fn();
    const pendingA = consumeCloudLifecycleFollowUps(AUTHORITY_A, accountA);
    const accountB = vi.fn();
    await consumeCloudLifecycleFollowUps(AUTHORITY_B, accountB);
    resolveAccountA?.({ notices: [notice()] });
    await pendingA;

    expect(accountB).not.toHaveBeenCalled();
    expect(accountA).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed nested lifecycle event kinds and fields", async () => {
    vi.spyOn(client, "claimCloudLifecycleFollowUps").mockResolvedValue({
      notices: [
        notice({
          lifecycleEvents: [
            {
              kind: "internal_admin_event",
              idempotencyKey: "event-1",
              resourceId: "resource-1",
            },
          ],
        }),
        notice({
          lifecycleEvents: [
            {
              kind: "connector_connected",
              idempotencyKey: "",
              resourceId: "resource-1",
            },
          ],
        }),
      ],
    });
    const ack = vi.spyOn(client, "acknowledgeCloudLifecycleFollowUps");
    const accept = vi.fn();

    await consumeCloudLifecycleFollowUps(AUTHORITY_A, accept);

    expect(accept).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });

  it("accepts a 4000-character continuation only when bound to its target agent", async () => {
    const agentId = "22222222-2222-4222-8222-222222222222";
    const originalIntent = "x".repeat(4000);
    vi.spyOn(client, "claimCloudLifecycleFollowUps").mockResolvedValue({
      notices: [
        notice({
          lifecycleEvents: [
            {
              kind: "connector_connected",
              idempotencyKey: "connector-connected:1",
              resourceId: "connection-1",
              agentId,
              continuation: {
                originalIntent,
                capabilityId: "calendar",
                requiresConfirmation: true,
              },
            },
          ],
        }),
      ],
    });
    vi.spyOn(client, "acknowledgeCloudLifecycleFollowUps").mockResolvedValue({
      acknowledged: 1,
    });
    const accept = vi.fn();

    await consumeCloudLifecycleFollowUps(AUTHORITY_A, accept);

    expect(accept.mock.calls[0]?.[0]).toMatchObject({
      deepLink: `/chat?prefill=${encodeURIComponent(originalIntent)}`,
      data: {
        lifecycleEvents: [{ agentId }],
        continuations: [{ originalIntent, agentId }],
        continuationPolicy: "offer_only_never_auto_execute",
      },
    });
  });

  it("rejects a continuation over 4000 characters or without a target agent", async () => {
    const event = {
      kind: "connector_connected",
      idempotencyKey: "connector-connected:1",
      resourceId: "connection-1",
      continuation: {
        originalIntent: "x".repeat(4001),
        capabilityId: "calendar",
        requiresConfirmation: true,
      },
    };
    vi.spyOn(client, "claimCloudLifecycleFollowUps").mockResolvedValue({
      notices: [
        notice({ lifecycleEvents: [event] }),
        notice({
          lifecycleEvents: [
            {
              ...event,
              continuation: {
                ...event.continuation,
                originalIntent: "connect my calendar",
              },
            },
          ],
        }),
      ],
    });
    const accept = vi.fn();
    const ack = vi.spyOn(client, "acknowledgeCloudLifecycleFollowUps");

    await consumeCloudLifecycleFollowUps(AUTHORITY_A, accept);

    expect(accept).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });
});
