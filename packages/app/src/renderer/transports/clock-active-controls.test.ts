import { CLOCK_ALARMS_CAPABILITY } from "@elizaos/plugin-assistant/device-clock-review";
import type { ClockHost, ClockProposal } from "@elizaos/ui";
import { describe, expect, it, vi } from "vitest";
import { createClockActiveControls } from "./clock-active-controls";

function fixture() {
  const scope = "a".repeat(64);
  const proposal: ClockProposal = {
    id: "active-control",
    digest: "b".repeat(64),
    state: "pending",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    operation: {
      type: "clock_alarm",
      action: "snooze",
      alarmId: "387f40dd-93a9-4bdd-95ee-da48c3a1b188",
      minutes: 5,
    },
  };
  const status = {
    supported: true,
    scope,
    capabilities: [CLOCK_ALARMS_CAPABILITY],
  };
  const batch = { scope, proposals: [proposal] };
  const review = vi.fn(async () => ({ receiptPending: false }));
  const host = {
    status: vi.fn(async () => status),
    proposals: vi.fn(async () => batch),
    review,
  } as unknown as Pick<ClockHost, "status" | "proposals" | "review">;
  const error = vi.fn();
  return { scope, proposal, status, batch, review, host, error };
}

describe("app-global agent ringing controls", () => {
  it("dispatches Stop and Snooze through authenticated review without a Clock page", async () => {
    for (const action of ["dismiss", "snooze"] as const) {
      const f = fixture();
      f.proposal.operation =
        action === "snooze"
          ? {
              type: "clock_alarm",
              action,
              alarmId: "387f40dd-93a9-4bdd-95ee-da48c3a1b188",
              minutes: 5,
            }
          : {
              type: "clock_alarm",
              action,
              alarmId: "387f40dd-93a9-4bdd-95ee-da48c3a1b188",
            };
      await createClockActiveControls(f.host, f.error).refresh();
      expect(f.review).toHaveBeenCalledExactlyOnceWith(
        f.proposal,
        f.scope,
        expect.any(AbortSignal),
      );
      expect(f.error).not.toHaveBeenCalled();
    }
  });
  it("leaves schedule mutations and settled, expired or foreign-scope proposals untouched", async () => {
    for (const invalid of [
      "set",
      "delete",
      "done",
      "expired",
      "scope",
    ] as const) {
      const f = fixture();
      if (invalid === "set")
        f.proposal.operation = {
          type: "clock_alarm",
          action: "set",
          hour: 9,
          minute: 0,
          label: "Future",
          timeZone: "UTC",
          days: [],
        };
      if (invalid === "delete")
        f.proposal.operation = {
          type: "clock_alarm",
          action: "delete",
          alarmId: "387f40dd-93a9-4bdd-95ee-da48c3a1b188",
        };
      if (invalid === "done") f.proposal.state = "done";
      if (invalid === "expired")
        f.proposal.expiresAt = new Date(0).toISOString();
      if (invalid === "scope") f.batch.scope = "c".repeat(64);
      await createClockActiveControls(f.host, f.error).refresh();
      expect(f.review).not.toHaveBeenCalled();
    }
  });
  it("coalesces concurrent change events and never replays an ambiguous effect", async () => {
    const f = fixture();
    let release!: () => void;
    f.review.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new Error("Receipt publication lost after native effect");
    });
    const controls = createClockActiveControls(f.host, f.error);
    const first = controls.refresh();
    await vi.waitFor(() => expect(f.review).toHaveBeenCalledOnce());
    const second = controls.refresh();
    release();
    await Promise.all([first, second]);
    await controls.refresh();
    expect(f.review).toHaveBeenCalledOnce();
    expect(f.error).toHaveBeenCalledOnce();
  });
  it("retires pending scans when the native owner lifecycle ends", async () => {
    const f = fixture();
    const controls = createClockActiveControls(f.host, f.error);
    controls.stop();
    await controls.refresh();
    expect(f.host.status).not.toHaveBeenCalled();
    expect(f.review).not.toHaveBeenCalled();
  });
  it("does not dispatch for a native host without the owned alarm capability", async () => {
    const f = fixture();
    f.status.capabilities = [];
    await createClockActiveControls(f.host, f.error).refresh();
    expect(f.host.proposals).not.toHaveBeenCalled();
    expect(f.review).not.toHaveBeenCalled();
  });
});
