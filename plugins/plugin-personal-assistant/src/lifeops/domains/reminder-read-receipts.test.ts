import {describe, expect, it, vi} from "vitest";
import type {LifeOpsReminderAttempt} from "@elizaos/contracts";
import {RemindersDomain} from "./reminders-service.js";

describe("reminder read receipt authority", () => {
  function fixture(channel: LifeOpsReminderAttempt["channel"], outcome: LifeOpsReminderAttempt["outcome"] = "delivered") {
    const update = vi.fn(async () => {});
    const context = {repository: {updateReminderAttemptOutcome: update}, logLifeOpsWarn: vi.fn()} as unknown as ConstructorParameters<typeof RemindersDomain>[0];
    const domain = new RemindersDomain(context, {} as ConstructorParameters<typeof RemindersDomain>[1]);
    const attempt = {id: "existing-attempt", channel, outcome, attemptedAt: "2026-10-28T09:56:30.000Z"} as LifeOpsReminderAttempt;
    const activity = {lastSeenAt: Date.parse("2026-10-28T09:57:00.000Z")} as Parameters<RemindersDomain["scanReadReceipts"]>[1];
    return {domain, attempt, activity, update};
  }
  it("does not treat unrelated activity as reading an in-app reminder", async () => {
    const f = fixture("in_app");
    await f.domain.scanReadReceipts([f.attempt], f.activity, new Date("2026-10-28T09:58:00.000Z"));
    expect(f.update).not.toHaveBeenCalled();
    expect(f.attempt.outcome).toBe("delivered");
  });
  it("does not rewrite historical in-app read receipts", async () => {
    const f = fixture("in_app", "delivered_read");
    await f.domain.scanReadReceipts([f.attempt], f.activity, new Date("2026-10-28T09:58:00.000Z"));
    expect(f.update).not.toHaveBeenCalled();
    expect(f.attempt.outcome).toBe("delivered_read");
  });
  it("preserves existing non-app channel reachability behavior", async () => {
    const f = fixture("sms");
    await f.domain.scanReadReceipts([f.attempt], f.activity, new Date("2026-10-28T09:58:00.000Z"));
    expect(f.update).toHaveBeenCalledExactlyOnceWith("existing-attempt", "delivered_read", {readDetectedAt: "2026-10-28T09:58:00.000Z"});
  });
  it("never invents a receipt when activity is unknown", async () => {
    const f = fixture("sms");
    await f.domain.scanReadReceipts([f.attempt], null, new Date("2026-10-28T09:58:00.000Z"));
    expect(f.update).not.toHaveBeenCalled();
  });
});
