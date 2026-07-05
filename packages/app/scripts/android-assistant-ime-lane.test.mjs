import { describe, expect, it } from "vitest";

import {
  ASSIST_SESSION_DEEPLINK,
  assertSecureSetting,
  DEFAULT_IME_ID,
  DEFAULT_PACKAGE,
  IME_SESSION_DEEPLINK,
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
      "shell",
      "cmd",
      "role",
      "add-role-holder",
      "android.app.role.ASSISTANT",
      "ai.elizaos.app",
    ]);
    expect(c.imeEnable).toEqual([
      "shell",
      "ime",
      "enable",
      "ai.elizaos.app/.Ime",
    ]);
    expect(c.imeSet).toEqual(["shell", "ime", "set", "ai.elizaos.app/.Ime"]);
    expect(DEFAULT_IME_ID).toBe("ai.elizaos.app/.ElizaVoiceInputMethodService");
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
  const adbWith = (out) =>
    makeAdb("s", mockExec({ "shell settings get secure": out }));
  it("passes when the value references the expected substring", () => {
    const r = assertSecureSetting(
      adbWith("ai.elizaos.app/.voice.ElizaVoiceInteractionService"),
      "voice_interaction_service",
      "ai.elizaos.app",
    );
    expect(r.ok).toBe(true);
  });
  it("fails on unset ('null'), empty, or a foreign value", () => {
    expect(assertSecureSetting(adbWith("null"), "k", "ai.elizaos.app").ok).toBe(
      false,
    );
    expect(assertSecureSetting(adbWith(""), "k", "ai.elizaos.app").ok).toBe(
      false,
    );
    expect(
      assertSecureSetting(
        adbWith("com.google.android.googlequicksearchbox"),
        "k",
        "ai.elizaos.app",
      ).ok,
    ).toBe(false);
  });
});

describe("sessionLanded", () => {
  it("is true only when the deep-link AND MainActivity are both present", () => {
    expect(
      sessionLanded(
        `I ActivityTaskManager: START ${ASSIST_SESSION_DEEPLINK} cmp=ai.elizaos.app/.MainActivity`,
        ASSIST_SESSION_DEEPLINK,
      ),
    ).toBe(true);
    expect(
      sessionLanded(
        `START ${ASSIST_SESSION_DEEPLINK}`,
        ASSIST_SESSION_DEEPLINK,
      ),
    ).toBe(false); // no MainActivity
    expect(sessionLanded("MainActivity resumed", ASSIST_SESSION_DEEPLINK)).toBe(
      false,
    ); // no deep-link
    expect(sessionLanded("", ASSIST_SESSION_DEEPLINK)).toBe(false);
  });
});

describe("runLane", () => {
  const allRoutesLog = [
    `START u0 {act=android.intent.action.VIEW dat=${ASSIST_SESSION_DEEPLINK} cmp=ai.elizaos.app/.MainActivity}`,
    `START u0 {act=android.intent.action.VIEW dat=${IME_SESSION_DEEPLINK} cmp=ai.elizaos.app/.MainActivity}`,
  ].join("\n");
  const assistRouteLog = `START u0 {act=android.intent.action.VIEW dat=${ASSIST_SESSION_DEEPLINK} cmp=ai.elizaos.app/.MainActivity}`;
  const imeRouteLog = `START u0 {act=android.intent.action.VIEW dat=${IME_SESSION_DEEPLINK} cmp=ai.elizaos.app/.MainActivity}`;

  function routeAwareExec({
    voiceinteraction = assistRouteLog,
    assistKey = assistRouteLog,
    ime = imeRouteLog,
    voiceSetting = "ai.elizaos.app/.ElizaVoiceInteractionService",
    inputMethod = DEFAULT_IME_ID,
  } = {}) {
    const calls = [];
    let route = "voiceinteraction";
    const exec = (_bin, args) => {
      calls.push(args);
      const cmd = args.slice(2).join(" ");
      if (
        cmd.startsWith("shell settings get secure voice_interaction_service")
      ) {
        return { status: 0, stdout: voiceSetting, stderr: "" };
      }
      if (cmd.startsWith("shell settings get secure default_input_method")) {
        return { status: 0, stdout: inputMethod, stderr: "" };
      }
      if (cmd === "shell cmd voiceinteraction show") route = "voiceinteraction";
      if (cmd === "shell input keyevent KEYCODE_ASSIST") route = "assistKey";
      if (cmd.startsWith("shell am start ")) route = "ime";
      if (cmd === "logcat -d") {
        const stdout =
          route === "voiceinteraction"
            ? voiceinteraction
            : route === "assistKey"
              ? assistKey
              : ime;
        return { status: 0, stdout, stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    exec.calls = calls;
    return exec;
  }

  it("passes when role+IME applied and the assist session lands in MainActivity", async () => {
    const exec = routeAwareExec();
    const result = await runLane({
      serial: "emulator-5554",
      exec,
      settleMs: 0,
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.voiceinteractionLanded).toBe(true);
    expect(result.assistKeyLanded).toBe(true);
    expect(result.imeLanded).toBe(true);
    // Re-apply commands were issued in order.
    const cmds = exec.calls.map((a) => a.slice(2).join(" "));
    expect(cmds).toContain(
      `shell cmd role add-role-holder android.app.role.ASSISTANT ${DEFAULT_PACKAGE}`,
    );
    expect(cmds).toContain(`shell ime set ${DEFAULT_IME_ID}`);
    expect(cmds).toContain("shell cmd voiceinteraction show");
    expect(cmds).toContain("shell input keyevent KEYCODE_ASSIST");
    expect(cmds).toContain(
      `shell am start -a android.intent.action.VIEW -d ${IME_SESSION_DEEPLINK}&action=voice&voice=1 ${DEFAULT_PACKAGE}/.MainActivity`,
    );
  });

  it("canary: a renamed VIS (unset secure setting) turns the lane red", async () => {
    const exec = mockExec({
      "shell settings get secure voice_interaction_service": "null",
      "shell settings get secure default_input_method": DEFAULT_IME_ID,
      "logcat -d": allRoutesLog,
    });
    const result = await runLane({ serial: "s", exec, settleMs: 0 });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toMatch(/assistant role not applied/);
  });

  it("fails when cmd voiceinteraction does not route into MainActivity", async () => {
    const exec = routeAwareExec({ voiceinteraction: "no eliza session here" });
    const result = await runLane({ serial: "s", exec, settleMs: 0 });
    expect(result.ok).toBe(false);
    expect(result.assistKeyLanded).toBe(true);
    expect(result.failures.join("\n")).toMatch(/cmd voiceinteraction/);
  });

  it("fails when KEYCODE_ASSIST does not route into MainActivity", async () => {
    const exec = routeAwareExec({ assistKey: "no eliza session here" });
    const result = await runLane({ serial: "s", exec, settleMs: 0 });
    expect(result.ok).toBe(false);
    expect(result.voiceinteractionLanded).toBe(true);
    expect(result.failures.join("\n")).toMatch(/KEYCODE_ASSIST/);
  });

  it("fails when the IME open-app path does not route into MainActivity", async () => {
    const exec = routeAwareExec({ ime: assistRouteLog });
    const result = await runLane({ serial: "s", exec, settleMs: 0 });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toMatch(/IME open-app path/);
  });

  it("waits after each assistant route before reading logs", async () => {
    const exec = routeAwareExec();
    const waits = [];
    await runLane({
      serial: "s",
      exec,
      settleMs: 2_500,
      sleepFn: async (ms) => {
        waits.push(ms);
      },
    });

    const cmds = exec.calls.map((a) => a.slice(2).join(" "));
    const voiceIndex = cmds.indexOf("shell cmd voiceinteraction show");
    const keyIndex = cmds.indexOf("shell input keyevent KEYCODE_ASSIST");
    const imeIndex = cmds.findIndex((cmd) => cmd.startsWith("shell am start "));

    expect(cmds[voiceIndex + 1]).toBe("logcat -d");
    expect(cmds[keyIndex + 1]).toBe("logcat -d");
    expect(cmds[imeIndex + 1]).toBe("logcat -d");
    expect(waits).toEqual([2_500, 2_500, 2_500]);
  });
});
