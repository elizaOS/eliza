/** Verifies one-shot notification-center request delivery across shell mount order. */

import { afterEach, describe, expect, it } from "vitest";
import {
  consumeNotificationCenterOpenRequest,
  requestNotificationCenterOpen,
  subscribeNotificationCenterOpenRequests,
} from "./notification-center-open-request";

afterEach(() => {
  while (consumeNotificationCenterOpenRequest() !== null) {
    // Drain any retained request so each scenario starts without shell intent.
  }
});

describe("notification center open requests", () => {
  it("retains only the newest request until Home mounts and consumes it once", () => {
    const first = requestNotificationCenterOpen();
    const second = requestNotificationCenterOpen();

    expect(second).toBeGreaterThan(first);
    expect(consumeNotificationCenterOpenRequest()).toBe(second);
    expect(consumeNotificationCenterOpenRequest()).toBeNull();
  });

  it("delivers to a mounted Home subscriber without retaining a stale replay", () => {
    const received: number[] = [];
    const unsubscribe = subscribeNotificationCenterOpenRequests((requestId) =>
      received.push(requestId),
    );

    try {
      const requestId = requestNotificationCenterOpen();
      expect(received).toEqual([requestId]);
      expect(consumeNotificationCenterOpenRequest()).toBeNull();
    } finally {
      unsubscribe();
    }

    const retainedRequestId = requestNotificationCenterOpen();
    expect(consumeNotificationCenterOpenRequest()).toBe(retainedRequestId);
  });
});
