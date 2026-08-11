/**
 * Unit tests for the pure verdict logic of the iOS voice round-trip lane
 * (`evaluateVoiceSelfTestReport`). Deterministic — no simulator, no device, no
 * model; exercises the no-false-green contract (skipped != pass, transcript +
 * reply presence) that gates `ios-voice-selftest-smoke.mjs`. Runs in the
 * packages/app vitest suite (root `test:client` lane).
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildIosVoiceSelfTestPreferenceSeed,
  evaluateVoiceSelfTestReport,
  IOS_LOCAL_AGENT_IPC_BASE,
  iosLocalVoiceArtifactProblems,
  isIosVoiceSelfTestResultFresh,
  parseIosVoiceSelfTestMode,
  planIosVoiceSelfTestHost,
  REQUIRED_IOS_LOCAL_VOICE_ASSETS,
  REQUIRED_VOICE_STAGES,
  selectIosVoiceSelfTestBootTrace,
} from "./ios-voice-selftest-lib.mjs";

function stage(name, status) {
  return { stage: name, status, durationMs: 1, detail: {} };
}

function passingReport(overrides = {}) {
  return {
    schemaVersion: 1,
    overall: "pass",
    platform: "ios",
    mode: "wav-direct",
    ttsRoute: "/api/tts/local-inference",
    expectedPhrase: "what time is it",
    transcript: "what time is it",
    reply: "It is 3 o'clock.",
    sendBackend: "local-inference:eliza-1-2b",
    stages: [stage("asr", "pass"), stage("send", "pass"), stage("tts", "pass")],
    ...overrides,
  };
}

describe("evaluateVoiceSelfTestReport", () => {
  it("passes a fully green real round-trip", () => {
    const verdict = evaluateVoiceSelfTestReport(passingReport());
    expect(verdict.pass).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.stageStatuses).toEqual({
      asr: "pass",
      send: "pass",
      tts: "pass",
    });
    expect(verdict.transcript).toBe("what time is it");
    expect(verdict.reply).toBe("It is 3 o'clock.");
  });

  it("requires the three real pipeline stages", () => {
    expect(REQUIRED_VOICE_STAGES).toEqual(["asr", "send", "tts"]);
  });

  it("fails loudly when the ASR stage is skipped (not provisioned)", () => {
    const verdict = evaluateVoiceSelfTestReport(
      passingReport({
        overall: "fail",
        stages: [
          stage("asr", "skipped"),
          stage("send", "skipped"),
          stage("tts", "skipped"),
        ],
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toContain(
      'stage "asr" is "skipped", expected "pass"',
    );
  });

  it("treats an all-skipped overall=skipped report as a failure", () => {
    const verdict = evaluateVoiceSelfTestReport(
      passingReport({
        overall: "skipped",
        stages: [
          stage("asr", "skipped"),
          stage("send", "skipped"),
          stage("tts", "skipped"),
        ],
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toContain('overall is "skipped", expected "pass"');
  });

  it("fails when the agent send stage fails", () => {
    const verdict = evaluateVoiceSelfTestReport(
      passingReport({
        overall: "fail",
        reply: "",
        stages: [
          stage("asr", "pass"),
          stage("send", "fail"),
          stage("tts", "skipped"),
        ],
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toContain(
      'stage "send" is "fail", expected "pass"',
    );
    expect(verdict.reasons).toContain("agent reply is empty");
  });

  it("fails when the transcript does not contain the expected phrase word", () => {
    const verdict = evaluateVoiceSelfTestReport(
      passingReport({ transcript: "banana bread please" }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.some((r) => r.includes("does not contain"))).toBe(
      true,
    );
  });

  it("fails when a required stage is entirely absent", () => {
    const verdict = evaluateVoiceSelfTestReport(
      passingReport({ stages: [stage("asr", "pass"), stage("send", "pass")] }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toContain('stage "tts" is missing from the report');
  });

  it("does not throw on a missing/garbage report", () => {
    expect(evaluateVoiceSelfTestReport(null).pass).toBe(false);
    expect(evaluateVoiceSelfTestReport(undefined).pass).toBe(false);
    expect(evaluateVoiceSelfTestReport("nope").pass).toBe(false);
    expect(evaluateVoiceSelfTestReport(42).pass).toBe(false);
  });

  it("fails when overall is pass but a stage silently regressed to fail", () => {
    // Defends against trusting `overall` alone — the stage grid is authoritative.
    const verdict = evaluateVoiceSelfTestReport(
      passingReport({
        stages: [
          stage("asr", "pass"),
          stage("send", "pass"),
          stage("tts", "fail"),
        ],
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toContain('stage "tts" is "fail", expected "pass"');
  });
});

describe("iOS voice self-test mode and state contracts", () => {
  it("ships explicit local and remote package entrypoints", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(packageJson.scripts["test:e2e:ios:voice"]).toMatch(/--mode local$/);
    expect(packageJson.scripts["test:e2e:ios:voice:remote"]).toMatch(
      /--mode remote$/,
    );
  });

  it("defaults the shipped command to local and rejects remote bases in local mode", () => {
    expect(parseIosVoiceSelfTestMode([])).toEqual({
      mode: "local",
      apiBase: null,
    });
    expect(
      parseIosVoiceSelfTestMode([
        "--mode",
        "local",
        "--api-base",
        IOS_LOCAL_AGENT_IPC_BASE,
      ]),
    ).toEqual({ mode: "local", apiBase: IOS_LOCAL_AGENT_IPC_BASE });
    expect(() =>
      parseIosVoiceSelfTestMode([
        "--mode",
        "local",
        "--api-base",
        "http://127.0.0.1:31338",
      ]),
    ).toThrow(/always uses eliza-local-agent:\/\/ipc/);
    expect(() => parseIosVoiceSelfTestMode(["--mode", "cloud"])).toThrow(
      /local or remote/,
    );
    expect(() => parseIosVoiceSelfTestMode(["--mode"])).toThrow(
      /--mode requires a value/,
    );
    expect(() => parseIosVoiceSelfTestMode(["--api-base"])).toThrow(
      /--api-base requires a value/,
    );
  });

  it("owns a host only for remote mode without an external api base", () => {
    expect(planIosVoiceSelfTestHost({ mode: "local", apiBase: null })).toEqual({
      apiBase: IOS_LOCAL_AGENT_IPC_BASE,
      ownsHostAgent: false,
    });
    expect(planIosVoiceSelfTestHost({ mode: "remote", apiBase: null })).toEqual(
      {
        apiBase: null,
        ownsHostAgent: true,
      },
    );
    expect(
      planIosVoiceSelfTestHost({
        mode: "remote",
        apiBase: "http://127.0.0.1:31338",
      }),
    ).toEqual({
      apiBase: "http://127.0.0.1:31338",
      ownsHostAgent: false,
    });
  });

  it("seeds canonical local runtime state without remote onboarding", () => {
    const requestedAt = "2026-08-11T09:30:00.000Z";
    const entries = buildIosVoiceSelfTestPreferenceSeed({
      mode: "local",
      apiBase: IOS_LOCAL_AGENT_IPC_BASE,
      runId: "voice-run-1",
      requestedAt,
      deadlineAt: "2026-08-11T09:50:00.000Z",
    });
    expect(entries["eliza:mobile-runtime-mode"]).toBe("local");
    expect(entries["eliza:first-run-complete"]).toBe("1");
    expect(entries["elizaos:active-server"]).toBeUndefined();
    expect(entries["eliza:ios-onboarding-smoke:request"]).toBeUndefined();
    expect(
      JSON.parse(entries["eliza:ios-voice-selftest:request"]),
    ).toMatchObject({
      mode: "local",
      apiBase: IOS_LOCAL_AGENT_IPC_BASE,
      runId: "voice-run-1",
      requestedAt,
      deadlineAt: "2026-08-11T09:50:00.000Z",
    });
  });

  it("seeds onboarding only for explicit remote compatibility mode", () => {
    const entries = buildIosVoiceSelfTestPreferenceSeed({
      mode: "remote",
      apiBase: "http://127.0.0.1:31338",
      runId: "voice-run-2",
      requestedAt: "2026-08-11T09:31:00.000Z",
      deadlineAt: "2026-08-11T09:51:00.000Z",
    });
    expect(entries["eliza:mobile-runtime-mode"]).toBeUndefined();
    expect(entries["elizaos:active-server"]).toBeUndefined();
    expect(entries["eliza:ios-onboarding-smoke:request"]).toBe(
      JSON.stringify({ apiBase: "http://127.0.0.1:31338" }),
    );
  });

  it("accepts only exact-run results produced after the request", () => {
    const requestedAtMs = Date.parse("2026-08-11T09:30:00.000Z");
    expect(
      isIosVoiceSelfTestResultFresh(
        {
          runId: "voice-run-1",
          finishedAt: "2026-08-11T09:30:00.001Z",
        },
        { runId: "voice-run-1", requestedAtMs },
      ),
    ).toBe(true);
    expect(
      isIosVoiceSelfTestResultFresh(
        {
          runId: "old-run",
          finishedAt: "2026-08-11T09:31:00.000Z",
        },
        { runId: "voice-run-1", requestedAtMs },
      ),
    ).toBe(false);
    expect(
      isIosVoiceSelfTestResultFresh(
        {
          runId: "voice-run-1",
          finishedAt: "2026-08-11T09:29:59.999Z",
        },
        { runId: "voice-run-1", requestedAtMs },
      ),
    ).toBe(false);
  });

  it("validates each supported VAD representation under its real format", () => {
    const vad = REQUIRED_IOS_LOCAL_VOICE_ASSETS.find(
      (asset) => asset.id === "vad",
    );
    expect(vad.candidates).toEqual([
      expect.objectContaining({
        relativePath: "vad/silero-vad-v5.gguf",
        magic: "GGUF",
      }),
      expect.objectContaining({
        relativePath: "vad/silero-vad-v5.1.2.ggml.bin",
        magic: "ggml",
      }),
    ]);
  });
});

describe("iOS local voice backend proof", () => {
  it.each([undefined, "remote-provider", "local-inference:unknown-model"])(
    "rejects backend %s for authoritative local mode",
    (sendBackend) => {
      const verdict = evaluateVoiceSelfTestReport(
        passingReport({ sendBackend }),
        { requireLocalInference: true },
      );
      expect(verdict.pass).toBe(false);
      expect(verdict.reasons).toContainEqual(
        expect.stringContaining("known local-inference model"),
      );
    },
  );

  it("accepts a concrete local model and leaves remote mode compatible", () => {
    expect(
      evaluateVoiceSelfTestReport(passingReport(), {
        requireLocalInference: true,
      }).pass,
    ).toBe(true);
    expect(
      evaluateVoiceSelfTestReport(
        passingReport({ sendBackend: "remote-provider" }),
      ).pass,
    ).toBe(true);
  });

  it.each([
    ["platform", { platform: "android" }],
    ["mode", { mode: "inject-transcript" }],
    ["TTS route", { ttsRoute: "/api/tts/cloud" }],
  ])("rejects a non-production local %s", (_label, override) => {
    const verdict = evaluateVoiceSelfTestReport(passingReport(override), {
      requireLocalInference: true,
    });
    expect(verdict.pass).toBe(false);
  });
});

describe("iOS run-owned native boot trace", () => {
  const requestedAtMs = Date.parse("2026-08-11T09:30:00.000Z");
  const entry = (stage, extra = {}) => ({
    ts: "2026-08-11T09:30:01.000Z",
    traceId: "current-trace",
    source: "test",
    stage,
    ...extra,
  });
  const complete = [
    entry("process-launch"),
    entry("engine-bootstrap-ok", { engineMode: "bun" }),
    entry("agent-boot-phase", { phase: "ready" }),
  ];

  it("selects exactly one current launch with process, engine, and agent readiness", () => {
    const selected = selectIosVoiceSelfTestBootTrace(
      [
        {
          ...entry("process-launch"),
          ts: "2026-08-11T09:29:59.000Z",
          traceId: "old-trace",
        },
        ...complete,
      ],
      { requestedAtMs },
    );
    expect(selected.traceId).toBe("current-trace");
    expect(selected.entries).toHaveLength(3);
    expect(selected.required).toEqual({
      processLaunch: true,
      engineReady: true,
      agentReady: true,
    });
  });

  it("rejects mixed launches and missing readiness stages", () => {
    expect(() =>
      selectIosVoiceSelfTestBootTrace(
        [...complete, { ...entry("probe", { ready: true }), traceId: "other" }],
        { requestedAtMs },
      ),
    ).toThrow(/exactly one current launch/);
    expect(() =>
      selectIosVoiceSelfTestBootTrace([entry("process-launch")], {
        requestedAtMs,
      }),
    ).toThrow(/lacks required current-run stages/);
  });

  it("rejects compatibility engines and trace-less stages", () => {
    expect(() =>
      selectIosVoiceSelfTestBootTrace(
        [
          entry("process-launch"),
          entry("engine-bootstrap-ok", { engineMode: "compat" }),
          entry("agent-boot-phase", { phase: "ready" }),
        ],
        { requestedAtMs },
      ),
    ).toThrow(/lacks required current-run stages/);
    expect(() =>
      selectIosVoiceSelfTestBootTrace(
        [
          entry("process-launch"),
          {
            ...entry("engine-bootstrap-ok", { engineMode: "bun" }),
            traceId: undefined,
          },
          entry("agent-boot-phase", { phase: "ready" }),
        ],
        { requestedAtMs },
      ),
    ).toThrow(/lacks required current-run stages/);
  });
});

describe("iOS local voice app artifact contract", () => {
  const valid = {
    manifest: {
      commit: "9294851",
      capacitorTarget: "ios",
      runtimeMode: "local",
    },
    expectedCommit: "9294851",
    agentBundleBytes: 10,
    engineBytes: 10,
    engineAbiVersion: "3",
    engineNoJit: true,
    engineExecutionProfile: "ios-app-store-nojit",
    architectures: "arm64",
    exportedSymbols:
      "eliza_inference_asr_transcribe eliza_inference_tts_synthesize eliza_inference_vad_supported",
  };

  it("accepts a fresh local full-Bun build with the fused voice ABI", () => {
    expect(iosLocalVoiceArtifactProblems(valid)).toEqual([]);
  });

  it("rejects a stale or non-fused app before evidence collection", () => {
    const problems = iosLocalVoiceArtifactProblems({
      ...valid,
      manifest: { ...valid.manifest, commit: "stale", runtimeMode: "cloud" },
      exportedSymbols:
        "eliza_inference_asr_transcribe eliza_inference_tts_synthesize",
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        "renderer commit stale != 9294851",
        "renderer runtimeMode cloud != local",
        "fused local-voice symbol eliza_inference_vad_supported is missing",
      ]),
    );
  });
});
