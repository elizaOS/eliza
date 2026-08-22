/** Verifies the browser-storage contract shared by desktop startup and Settings. */
// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PUSH_TO_TALK_ACCELERATOR,
  getPushToTalkAccelerator,
  setPushToTalkAccelerator,
} from "./push-to-talk-hotkey";

describe("push-to-talk hotkey storage", () => {
  beforeEach(() => window.localStorage.clear());

  it("uses the desktop startup default when no preference exists", () => {
    expect(getPushToTalkAccelerator()).toBe(DEFAULT_PUSH_TO_TALK_ACCELERATOR);
  });

  it("round-trips a supported accelerator", () => {
    setPushToTalkAccelerator("CommandOrControl+Alt+R");
    expect(getPushToTalkAccelerator()).toBe("CommandOrControl+Alt+R");
  });

  it.each([
    "not an accelerator",
    "CommandOrControl",
    "Hyper+R",
    "R",
    "7",
    "Shift+Shift+R",
    "",
  ])(
    "rejects malformed persisted value %j in favor of the default",
    (value) => {
      window.localStorage.setItem("eliza:pushToTalkHotkey", value);
      expect(getPushToTalkAccelerator()).toBe(DEFAULT_PUSH_TO_TALK_ACCELERATOR);
    },
  );
});
