import { afterEach, describe, expect, it, vi } from "vitest";
import { parentAliasesForCandidateAction } from "./action-retrieval.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("candidate hints for native-owned domains", () => {
  it.each([
    ["WAKE_ME_UP", ["PROPOSE_DEVICE_ACTION"]],
    ["SET_ALARM", ["PROPOSE_DEVICE_ACTION"]],
    ["OWNER_DELETE_ALARM", ["PROPOSE_DEVICE_ACTION"]],
    ["OWNER_ALARMS", ["PROPOSE_DEVICE_ACTION"]],
    [
      "CREATE_REMINDER",
      ["DEVICE_REMINDER_CREATE", "DEVICE_REMINDER_CREATE_AFTER"],
    ],
    [
      "OWNER_REMINDERS",
      ["DEVICE_REMINDER_CREATE", "DEVICE_REMINDER_CREATE_AFTER"],
    ],
    ["RESCHEDULE_REMINDER", ["DEVICE_REMINDER_UPDATE"]],
    ["OWNER_DELETE_REMINDER", ["DEVICE_REMINDER_CANCEL"]],
  ])("maps %s to the device tools, never TRIGGER", (name, expected) => {
    vi.stubEnv("ELIZA_NATIVE_OWNED_DOMAINS", "alarms,reminders");
    const aliases = parentAliasesForCandidateAction(name);
    expect(aliases).toEqual(expected);
    expect(aliases).not.toContain("TRIGGER");
  });

  it("leaves to-do hints alone unless the host owns to-dos", () => {
    vi.stubEnv("ELIZA_NATIVE_OWNED_DOMAINS", "alarms,reminders");
    expect(parentAliasesForCandidateAction("CREATE_TODO")).toEqual([
      "OWNER_TODOS",
      "TODO",
    ]);
    vi.stubEnv("ELIZA_NATIVE_OWNED_DOMAINS", "todos");
    expect(parentAliasesForCandidateAction("COMPLETE_TODO")).toEqual([
      "DEVICE_REMINDER_COMPLETE",
    ]);
  });

  it("keeps today's owner and scheduler hints without the setting", () => {
    vi.stubEnv("ELIZA_NATIVE_OWNED_DOMAINS", "");
    expect(parentAliasesForCandidateAction("WAKE_ME_UP")).toEqual([
      "PROPOSE_DEVICE_ACTION",
      "OWNER_ALARMS",
      "TRIGGER",
    ]);
    expect(parentAliasesForCandidateAction("CREATE_REMINDER")).toEqual([
      "OWNER_REMINDERS",
      "TRIGGER",
    ]);
  });

  it.each([
    "ADD_ALARM",
    "SET_ALARM",
    "CREATE_ALARM",
    "ALARM_CREATE",
    "WAKE_ME_UP",
    "OWNER_CREATE_ALARM",
  ])("hints the device Clock proposal before OWNER_ALARMS for %s", (name) => {
    vi.stubEnv("ELIZA_NATIVE_OWNED_DOMAINS", "");
    const aliases = parentAliasesForCandidateAction(name);
    expect(aliases[0]).toBe("PROPOSE_DEVICE_ACTION");
    expect(aliases.indexOf("PROPOSE_DEVICE_ACTION")).toBeLessThan(
      aliases.indexOf("OWNER_ALARMS"),
    );
  });
});
