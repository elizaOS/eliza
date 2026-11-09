import { afterEach, describe, expect, it, vi } from "vitest";
import { inferDirectCurrentRequestCandidateActions } from "./direct-action-heuristics.ts";

const phoneActions = [
  { name: "PROPOSE_DEVICE_ACTION" },
  { name: "DEVICE_REMINDER_CREATE" },
  { name: "TRIGGER" },
  { name: "OWNER_ROUTINES" },
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("alarm wording when Clock owns alarms", () => {
  it.each(["cancel my 7am alarm", "snooze my alarm", "what are my alarms"])(
    "routes to the clock handoff: %s",
    (text) => {
      vi.stubEnv("ELIZA_NATIVE_OWNED_DOMAINS", "alarms,reminders");
      expect(
        inferDirectCurrentRequestCandidateActions(phoneActions, text),
      ).toEqual(["PROPOSE_DEVICE_ACTION"]);
    },
  );

  it("keeps the LifeOps alarm owner without the setting", () => {
    vi.stubEnv("ELIZA_NATIVE_OWNED_DOMAINS", "");
    expect(
      inferDirectCurrentRequestCandidateActions(
        [...phoneActions, { name: "OWNER_ALARMS" }],
        "cancel my 7am alarm",
      ),
    ).toEqual(["OWNER_ALARMS"]);
  });
});
