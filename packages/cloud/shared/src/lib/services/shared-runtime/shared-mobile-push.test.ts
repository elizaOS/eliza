/** Verifies that canonical agent notification events dispatch one mobile-push payload through the Shared host boundary. */

import type { AgentEventPayload } from "@elizaos/core/edge";
import { describe, expect, it, vi } from "vitest";
import { SHARED_NOTIFICATION_SERVICES, subscribeSharedMobilePush } from "./shared-eliza-runtime";

describe("subscribeSharedMobilePush", () => {
  it("registers the canonical event bus and notification producer on Shared", () => {
    expect(SHARED_NOTIFICATION_SERVICES.map((service) => service.serviceType)).toEqual([
      "agent_event",
      "notification",
    ]);
  });

  it("dispatches notification events with the canonical deep-link metadata", async () => {
    let listener: ((event: AgentEventPayload) => void) | undefined;
    const unsubscribe = vi.fn();
    const dispatch = vi.fn(async () => {});
    const pending: Promise<void>[] = [];

    const stop = subscribeSharedMobilePush(
      {
        subscribe(next) {
          listener = next;
          return unsubscribe;
        },
      },
      dispatch,
      pending,
    );

    listener?.({
      runId: "run-1",
      seq: 1,
      stream: "notification",
      ts: 1,
      data: {
        notification: {
          id: "notification-1",
          title: "Reminder",
          body: "Leave for the airport",
          category: "reminder",
          priority: "high",
          source: "scheduling",
          deepLink: "/automations/flight",
          groupKey: "flight",
          createdAt: 1,
        },
      },
    });

    await Promise.all(pending);
    expect(dispatch).toHaveBeenCalledWith({
      title: "Reminder",
      body: "Leave for the airport",
      collapseKey: "notification-1",
      data: {
        notificationId: "notification-1",
        category: "reminder",
        deepLink: "/automations/flight",
        groupKey: "flight",
      },
    });
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("ignores non-notification streams and malformed notification events", () => {
    let listener: ((event: AgentEventPayload) => void) | undefined;
    const dispatch = vi.fn(async () => {});
    const pending: Promise<void>[] = [];
    subscribeSharedMobilePush(
      {
        subscribe(next) {
          listener = next;
          return () => {};
        },
      },
      dispatch,
      pending,
    );

    listener?.({ runId: "run-1", seq: 1, stream: "tool", ts: 1, data: {} });
    listener?.({
      runId: "run-1",
      seq: 2,
      stream: "notification",
      ts: 2,
      data: { notification: { title: "missing id" } },
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(pending).toHaveLength(0);
  });
});
