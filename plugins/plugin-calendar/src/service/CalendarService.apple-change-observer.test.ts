/** Verifies that native EventKit change delivery invalidates Apple's durable calendar cache and tears down safely. */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPLE_CALENDAR_GRANT_ID,
  APPLE_CALENDAR_PROVIDER,
  __testing as appleCalendarTesting,
} from "../apple-calendar.js";
import { CalendarService } from "./CalendarService.js";

type CalendarChangeHarness = {
  installAppleCalendarChangeObserver(): Promise<void>;
};

describe("CalendarService Apple change observation", () => {
  afterEach(() => {
    appleCalendarTesting.setNativeCalendarBridgeForTest(null);
  });

  it("invalidates the Apple sync cache on delivery and unsubscribes on stop", async () => {
    let deliverChange: ((event: { observedAt: string }) => void) | undefined;
    const remove = vi.fn(async () => undefined);
    const deleteCalendarSyncState = vi.fn(async () => undefined);
    const reportError = vi.fn();

    appleCalendarTesting.setNativeCalendarBridgeForTest({
      addListener: vi.fn(async (_eventName, listener) => {
        deliverChange = listener;
        return { remove };
      }),
    } as never);

    const service = Object.create(CalendarService.prototype) as CalendarService;
    Object.assign(service, {
      runtime: { agentId: "agent-1", reportError },
      repo: { deleteCalendarSyncState },
      appleCalendarChangeListener: null,
    });

    await (
      service as unknown as CalendarChangeHarness
    ).installAppleCalendarChangeObserver();
    expect(deliverChange).toBeTypeOf("function");
    deliverChange?.({ observedAt: "2026-08-26T12:00:00.000Z" });

    await vi.waitFor(() => {
      expect(deleteCalendarSyncState).toHaveBeenCalledWith(
        "agent-1",
        APPLE_CALENDAR_PROVIDER,
        undefined,
        "owner",
        APPLE_CALENDAR_GRANT_ID,
      );
    });
    expect(reportError).not.toHaveBeenCalled();

    await service.stop();
    await service.stop();
    expect(remove).toHaveBeenCalledOnce();
  });
});
