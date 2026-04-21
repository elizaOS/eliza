import { describe, expect, it } from "vitest";
import { actionsAreScenarioEquivalent } from "../action-families";

describe("action family equivalence", () => {
  it("treats approval-backed email execution as equivalent to inbox and gmail families", () => {
    expect(actionsAreScenarioEquivalent("SEND_EMAIL", "GMAIL_ACTION")).toBe(true);
    expect(actionsAreScenarioEquivalent("SEND_EMAIL", "INBOX")).toBe(true);
  });

  it("treats approval-backed message execution as equivalent to cross-channel and inbox families", () => {
    expect(actionsAreScenarioEquivalent("SEND_MESSAGE", "CROSS_CHANNEL_SEND")).toBe(true);
    expect(actionsAreScenarioEquivalent("SEND_MESSAGE", "INBOX")).toBe(true);
  });

  it("treats approval-backed calendar mutations as equivalent to calendar families", () => {
    expect(actionsAreScenarioEquivalent("MODIFY_EVENT", "CALENDAR_ACTION")).toBe(true);
    expect(actionsAreScenarioEquivalent("CANCEL_EVENT", "OWNER_CALENDAR")).toBe(true);
  });

  it("treats approval-backed calls as equivalent to call actions", () => {
    expect(actionsAreScenarioEquivalent("MAKE_CALL", "CALL_USER")).toBe(true);
    expect(actionsAreScenarioEquivalent("MAKE_CALL", "CALL_EXTERNAL")).toBe(true);
  });
});
