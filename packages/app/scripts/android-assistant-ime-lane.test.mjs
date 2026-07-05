import { describe, expect, it } from "vitest";

import {
  ASSIST_SESSION_DEEPLINK,
  DEFAULT_IME_ID,
  DEFAULT_PACKAGE,
  assertSecureSetting,
  makeAdb,
  reapplyCommands,
  runLane,
  sessionLanded,
} from "./android-assistant-ime-lane.mjs";

/**
 * A mock `exec` that routes by the tail of the adb command. `responses` maps a
 * matcher key → stdout string. Records every invocation for assertions.
 */
function mockExec(responses = {}) {
  const calls = [];
  const impl = (_bin, args) => {
    calls.push(args);
    // args = ["-s", serial, ...cmd]; match on the command tail.
    const cmd = args.slice(2).join(" ");
    for (const [key, out] of Object.entries(responses)) {
      if (cmd.startsWith(key)) return { status: 0, stdout: out, stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  impl.calls = calls;
  return impl;
}

describe("reapplyCommands", () => {
  it("emits the exact role + IME adb arg vectors", () => {
    const c = reapplyCommands("ai.elizaos.app", "ai.elizaos.app/.Ime");
    expect(c.role).toEqual([
      "shell", "cmd", "role", "add-role-holder",
      "android.app.role.ASSISTANT", "ai.elizaos.app",
    ]);
    expect(c.imeEnable).toEqual(["shell", "ime", "enable", "ai.elizaos.app/.Ime"]);
    expect(c.imeSet).toEqual(["shell", "ime", "set", "ai.elizaos.app/.Ime"]);
  });
});

describe("makeAdb", () => {
  it("requires a serial and prefixes -s <serial>", () => {
    expect(() => makeAdb("")).toThrow(/serial is required/);
    const exec = mockExec();
    const adb = makeAdb("emulator-5554", exec);
    adb(["shell", "true"]);
    expect(exec.calls[0]).toEqual(["-s", "emulator-5554", "shell", "true"]);
  });
});

describe("assertSecureSetting", () => {
  const adbWith = (out) => makeAdb("s", mockExec({ "shell settings get secure": out }));
  it("passes when the value references the expected substring", () => {
    const r = assertSecureSetting(
      adbWith("ai.elizaos.app/.voice.ElizaVoiceInteractionService"),
      "voice_interaction_service",
      "ai.elizaos.app",
    );
    expect(r.ok).toBe(true);
  });
  it("fails on unset ('null'), empty, or a foreign value", () => {
    expect(assertSecureSetting(adbWith("null"), "k", "ai.elizaos.app").ok).toBe(false);
    expect(assertSecureSetting(adbWith(""), "k", "ai.elizaos.app").ok).toBe(false);
    expect(
      assertSecureSetting(adbWith("com.google.android.googlequicksearchbox"), "k", "ai.elizaos.app").ok,
    ).toBe(false);
  });
});

describe("sessionLanded", () => {
  it("is true only when the deep-link AND MainActivity are both present", () => {
    expect(
      sessionLanded(`I ActivityTaskManager: START ${ASSIST_SESSION_DEEPLINK} cmp=ai.elizaos.app/.MainActivity`, ASSIST_SESSION_DEEPLINK),
    ).toBe(true);
    expect(sessionLanded(`START ${ASSIST_SESSION_DEEPLINK}`, ASSIST_SESSION_DEEPLINK)).toBe(false); // no MainActivity
    expect(sessionLanded("MainActivity resumed", ASSIST_SESSION_DEEPLINK)).toBe(false); // no deep-link
    expect(sessionLanded("", ASSIST_SESSION_DEEPLINK)).toBe(false);
  });
});

describe("runLane", () => {
  const landedLog = `START u0 {act=android.intent.action.VIEW dat=${ASSIST_SESSION_DEEPLINK} cmp=ai.elizaos.app/.MainActivity}`;

  it("passes when role+IME applied and the assist session lands in MainActivity", async () => {
    const exec = mockExec({
      "shell settings get secure voice_interaction_service":
        "ai.elizaos.app/.voice.ElizaVoiceInteractionService",
      "shell settings get secure default_input_method": DEFAULT_IME_ID,
      "logcat -d": landedLog,
    });
    const result = await runLane({ serial: "emulator-5554", exec });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    // Re-apply commands were issued in order.
    const cmds = exec.calls.map((a) => a.slice(2).join(" "));
    expect(cmds).toContain(
      `shell cmd role add-role-holder android.app.role.ASSISTANT ${DEFAULT_PACKAGE}`,
    );
    expect(cmds).toContain(`shell ime set ${DEFAULT_IME_ID}`);
    expect(cmds).toContain("shell cmd voiceinteraction show");
    expect(cmds).toContain("shell input keyevent KEYCODE_ASSIST");
  });

  it("canary: a renamed VIS (unset secure setting) turns the lane red", async () => {
    const exec = mockExec({
      "shell settings get secure voice_interaction_service": "null",
      "shell settings get secure default_input_method": DEFAULT_IME_ID,
      "logcat -d": landedLog,
    });
    const result = await runLane({ serial: "s", exec });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toMatch(/assistant role not applied/);
  });

  it("fails when the assistant key does not route the deep-link into MainActivity (silent no-op)", async () => {
    const exec = mockExec({
      "shell settings get secure voice_interaction_service":
        "ai.elizaos.app/.voice.ElizaVoiceInteractionService",
      "shell settings get secure default_input_method": DEFAULT_IME_ID,
      "logcat -d": "no eliza session here",
    });
    const result = await runLane({ serial: "s", exec });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toMatch(/did not route .*MainActivity/);
  });
});
