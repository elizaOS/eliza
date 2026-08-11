/**
 * Deterministic contract tests for the voice self-test mode helpers
 * (`ios-voice-selftest-mode.mjs`). No simulator, no device, no model — these
 * pin the mode-parsing, local-runtime state-seeding, and remote/local host
 * ownership decisions that gate `ios-voice-selftest-smoke.mjs`, so a regression
 * that re-introduces the #18313 bug (pairing a host without local-inference)
 * fails loudly in the packages/app vitest suite.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOICE_SELFTEST_MODE,
  generateVoiceTraceId,
  IOS_LOCAL_AGENT_IPC_BASE,
  localActiveServerJson,
  localRuntimePreferenceWrites,
  onboardingRequestJson,
  parseVoiceSelfTestMode,
  shouldStartRemoteHost,
  VOICE_SELFTEST_MODES,
  voiceRequestJson,
} from "./ios-voice-selftest-mode.mjs";

describe("parseVoiceSelfTestMode", () => {
  it("defaults to local mode", () => {
    expect(parseVoiceSelfTestMode(["node", "script.mjs"])).toBe(
      DEFAULT_VOICE_SELFTEST_MODE,
    );
    expect(DEFAULT_VOICE_SELFTEST_MODE).toBe("local");
  });

  it("parses --mode local", () => {
    expect(
      parseVoiceSelfTestMode(["node", "script.mjs", "--mode", "local"]),
    ).toBe("local");
  });

  it("parses --mode remote", () => {
    expect(
      parseVoiceSelfTestMode(["node", "script.mjs", "--mode", "remote"]),
    ).toBe("remote");
  });

  it("maps --local convenience flag", () => {
    expect(parseVoiceSelfTestMode(["node", "script.mjs", "--local"])).toBe(
      "local",
    );
  });

  it("maps --remote convenience flag", () => {
    expect(parseVoiceSelfTestMode(["node", "script.mjs", "--remote"])).toBe(
      "remote",
    );
  });

  it("throws on an invalid --mode value", () => {
    expect(() =>
      parseVoiceSelfTestMode(["node", "script.mjs", "--mode", "cloud"]),
    ).toThrow(/Invalid --mode/);
  });

  it("throws when --mode is the last token (missing value)", () => {
    expect(() =>
      parseVoiceSelfTestMode(["node", "script.mjs", "--mode"]),
    ).toThrow(/Invalid --mode/);
  });

  it("respects an explicit default override", () => {
    expect(
      parseVoiceSelfTestMode(["node", "script.mjs"], { default: "remote" }),
    ).toBe("remote");
  });
});

describe("shouldStartRemoteHost", () => {
  it("never starts a host in local mode", () => {
    expect(shouldStartRemoteHost({ mode: "local", apiBase: null })).toBe(false);
    expect(
      shouldStartRemoteHost({
        mode: "local",
        apiBase: "http://localhost:9999",
      }),
    ).toBe(false);
  });

  it("starts a host in remote mode without an explicit api-base", () => {
    expect(shouldStartRemoteHost({ mode: "remote", apiBase: null })).toBe(true);
  });

  it("does not start a host in remote mode with an explicit api-base", () => {
    expect(
      shouldStartRemoteHost({
        mode: "remote",
        apiBase: "http://example.com:31338",
      }),
    ).toBe(false);
  });
});

describe("localRuntimePreferenceWrites", () => {
  it("seeds mobile-runtime-mode, first-run-complete, and active-server in local mode", () => {
    const writes = localRuntimePreferenceWrites({ mode: "local" });
    expect(writes).toHaveLength(3);
    const byKey = Object.fromEntries(writes.map((w) => [w.key, w.value]));
    expect(byKey["eliza:mobile-runtime-mode"]).toBe("local");
    expect(byKey["eliza:first-run-complete"]).toBe("1");

    const activeServer = JSON.parse(byKey["elizaos:active-server"]);
    expect(activeServer.apiBase).toBe(IOS_LOCAL_AGENT_IPC_BASE);
    expect(activeServer.kind).toBe("remote");
    expect(activeServer.label).toBe("On-device agent");
  });

  it("returns no writes in remote mode (remote onboarding drives first-run)", () => {
    expect(localRuntimePreferenceWrites({ mode: "remote" })).toEqual([]);
  });
});

describe("onboardingRequestJson", () => {
  it("returns null in local mode (no remote onboarding)", () => {
    expect(onboardingRequestJson({ mode: "local", apiBase: null })).toBeNull();
  });

  it("stages the host apiBase in remote mode", () => {
    const json = onboardingRequestJson({
      mode: "remote",
      apiBase: "http://127.0.0.1:31338",
    });
    expect(JSON.parse(json)).toEqual({ apiBase: "http://127.0.0.1:31338" });
  });
});

describe("generateVoiceTraceId", () => {
  it("produces a unique ID each call", () => {
    const a = generateVoiceTraceId();
    const b = generateVoiceTraceId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^voice-/);
  });
});

describe("voiceRequestJson", () => {
  it("stages mode:'local' with the on-device IPC base in local mode", () => {
    const parsed = JSON.parse(
      voiceRequestJson({ mode: "local", apiBase: null }),
    );
    expect(parsed.mode).toBe("local");
    expect(parsed.apiBase).toBe(IOS_LOCAL_AGENT_IPC_BASE);
    expect(parsed.traceId).toMatch(/^voice-/);
    expect(typeof parsed.requestTimestamp).toBe("number");
  });

  it("stages mode:'remote' with the host apiBase in remote mode", () => {
    const parsed = JSON.parse(
      voiceRequestJson({
        mode: "remote",
        apiBase: "http://127.0.0.1:31338",
      }),
    );
    expect(parsed.mode).toBe("remote");
    expect(parsed.apiBase).toBe("http://127.0.0.1:31338");
    expect(parsed.traceId).toMatch(/^voice-/);
    expect(typeof parsed.requestTimestamp).toBe("number");
  });

  it("accepts an explicit traceId and echoes it", () => {
    const parsed = JSON.parse(
      voiceRequestJson({
        mode: "local",
        apiBase: null,
        traceId: "voice-test123-9999",
      }),
    );
    expect(parsed.traceId).toBe("voice-test123-9999");
  });

  it("generates unique traceIds for two calls without explicit traceId", () => {
    const a = JSON.parse(voiceRequestJson({ mode: "local", apiBase: null }));
    const b = JSON.parse(voiceRequestJson({ mode: "local", apiBase: null }));
    expect(a.traceId).not.toBe(b.traceId);
  });

  it("local mode never carries an empty object (finding #1 regression guard)", () => {
    const parsed = JSON.parse(
      voiceRequestJson({ mode: "local", apiBase: null }),
    );
    // The old code returned {} — that must never happen again
    expect(Object.keys(parsed).length).toBeGreaterThan(0);
    expect(parsed.mode).toBe("local");
  });
});

describe("localActiveServerJson", () => {
  it("produces the canonical eliza-local-agent://ipc record", () => {
    const parsed = JSON.parse(localActiveServerJson());
    expect(parsed).toEqual({
      id: "local:mobile",
      kind: "remote",
      label: "On-device agent",
      apiBase: IOS_LOCAL_AGENT_IPC_BASE,
    });
  });

  it("accepts a custom display label", () => {
    const parsed = JSON.parse(localActiveServerJson("Voice smoke agent"));
    expect(parsed.label).toBe("Voice smoke agent");
    expect(parsed.apiBase).toBe(IOS_LOCAL_AGENT_IPC_BASE);
  });
});

describe("VOICE_SELFTEST_MODES", () => {
  it("exposes exactly local and remote", () => {
    expect(VOICE_SELFTEST_MODES).toEqual(["local", "remote"]);
  });
});
