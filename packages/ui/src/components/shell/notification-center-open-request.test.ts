/** Verifies one-shot notification-center request delivery across shell mount order. */

import { afterEach, describe, expect, it } from "vitest";
import {
  acknowledgeNotificationCenterOpenRequest,
  peekNotificationCenterOpenRequest,
  requestNotificationCenterOpen,
  subscribeNotificationCenterOpenRequests,
} from "./notification-center-open-request";

afterEach(() => {
  const pendingRequestId = peekNotificationCenterOpenRequest();
  if (pendingRequestId !== null) {
    acknowledgeNotificationCenterOpenRequest(pendingRequestId);
  }
});

describe("notification center open requests", () => {
  it("retains only the newest request until Home mounts and consumes it once", () => {
    const first = requestNotificationCenterOpen();
    const second = requestNotificationCenterOpen();

    expect(second).toBeGreaterThan(first);
    expect(peekNotificationCenterOpenRequest()).toBe(second);
    expect(acknowledgeNotificationCenterOpenRequest(first)).toBe(false);
    expect(acknowledgeNotificationCenterOpenRequest(second)).toBe(true);
    expect(peekNotificationCenterOpenRequest()).toBeNull();
  });

  it("retains a delivered request until the visible Home acknowledges it", () => {
    const received: number[] = [];
    const unsubscribe = subscribeNotificationCenterOpenRequests((requestId) =>
      received.push(requestId),
    );

    try {
      const requestId = requestNotificationCenterOpen();
      expect(received).toEqual([requestId]);
      expect(peekNotificationCenterOpenRequest()).toBe(requestId);
      expect(acknowledgeNotificationCenterOpenRequest(requestId)).toBe(true);
      expect(peekNotificationCenterOpenRequest()).toBeNull();
    } finally {
      unsubscribe();
    }

    const retainedRequestId = requestNotificationCenterOpen();
    expect(peekNotificationCenterOpenRequest()).toBe(retainedRequestId);
  });
});
