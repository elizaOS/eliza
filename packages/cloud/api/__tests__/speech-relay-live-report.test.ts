import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publicSpeechRelayReports,
  reportedSpeechRelayTest,
  speechRelayFailure,
  speechRelayPhases,
  speechRelayRefusal,
  speechServerTimings,
} from "../test/speech-relay-live-report";

describe("protected speech diagnostics", () => {
  test("closed relay refusals survive reporting without provider text or arbitrary reasons", () => {
    const refusals = [
      ["unavailable", undefined, "SPEECH_REFUSED_UNAVAILABLE"],
      ["unauthorized", undefined, "SPEECH_REFUSED_UNAUTHORIZED"],
      [
        "unavailable",
        "insufficient_credits",
        "SPEECH_REFUSED_INSUFFICIENT_CREDITS",
      ],
      ["unavailable", "private-token", "SPEECH_REFUSED_UNAVAILABLE"],
      ["private-token", "insufficient_credits", "SPEECH_PROVIDER_REFUSED"],
    ] as const;
    for (const [code, reason, expected] of refusals) {
      const report = speechRelayFailure(
        "stt",
        new Error(speechRelayRefusal(code, reason)),
      );
      expect(report.code).toBe(expected);
      expect(
        JSON.parse(publicSpeechRelayReports(JSON.stringify(report), true)),
      ).toEqual(report);
      expect(JSON.stringify(report)).not.toContain("private-token");
    }
  });

  test("the live wrapper records the last stage and rejects without original error text", async () => {
    const lines: string[] = [];
    const error = new Error("provider response contains private-token");
    const run = reportedSpeechRelayTest(
      async (stage) => {
        stage("tts");
        throw error;
      },
      (line) => lines.push(line),
    );
    await expect(run()).rejects.toThrow("SPEECH_CONTRACT_FAILED");
    expect(lines).toEqual([
      JSON.stringify({
        phase: "speech-relay-live",
        status: "failed",
        stage: "tts",
        code: "SPEECH_CONTRACT_FAILED",
      }),
    ]);
  });

  test("reports the failed stage and exact known error without arbitrary error text", () => {
    expect(
      speechRelayFailure("ready", new Error("SPEECH_READY_TIMEOUT")),
    ).toEqual({
      phase: "speech-relay-live",
      status: "failed",
      stage: "ready",
      code: "SPEECH_READY_TIMEOUT",
    });
    expect(
      speechRelayFailure("consent", new Error("SPEECH_HTTP_STATUS_503")).code,
    ).toBe("SPEECH_HTTP_STATUS_503");
    for (const error of [
      new Error("Authorization: Bearer private-token"),
      new Error("SPEECH_READY_TIMEOUT private-token"),
      new Error("SPEECH_private_token"),
      { message: "SPEECH_READY_TIMEOUT", token: "private-token" },
    ]) {
      expect(speechRelayFailure("ready", error).code).toBe(
        "SPEECH_CONTRACT_FAILED",
      );
    }
    expect(
      speechRelayFailure("private-token", new Error("private-token")).stage,
    ).toBe("unknown");
  });

  test("the public parser discards private log lines and rebuilds failure records", () => {
    const log = [
      "Authorization: Bearer private-token",
      "Error: provider rejected secret customer text",
      JSON.stringify({
        phase: "speech-relay-live",
        status: "failed",
        stage: "tts",
        code: "SPEECH_TTS_TIMEOUT",
        token: "private-token",
        transcript: "secret customer text",
      }),
      JSON.stringify({
        phase: "speech-relay-live",
        status: "failed",
        stage: "private-token",
        code: "SPEECH_TTS_TIMEOUT private-token",
      }),
    ].join("\n");
    expect(
      publicSpeechRelayReports(log, true)
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        phase: "speech-relay-live",
        status: "failed",
        stage: "tts",
        code: "SPEECH_TTS_TIMEOUT",
      },
      {
        phase: "speech-relay-live",
        status: "failed",
        stage: "unknown",
        code: "SPEECH_CONTRACT_FAILED",
      },
    ]);
    expect(publicSpeechRelayReports(log, true)).not.toContain("private-token");
    expect(publicSpeechRelayReports(log, true)).not.toContain(
      "secret customer text",
    );
  });

  test("only safe numeric success metrics survive and failure cannot be reported as success", () => {
    const log = JSON.stringify({
      phase: "speech-relay-live",
      status: "passed",
      consentMs: 20,
      sessionMs: 60,
      wsReadyMs: 40,
      bootstrapMs: 120,
      ttsStartupMs: 120,
      firstPcmMs: 240,
      sttTailMs: 1280,
      pcmBytes: 1024,
      pcmFrames: true,
      sttFinalMs: -1,
      revokeMs: "private-token",
      token: "private-token",
      transcript: "secret customer text",
    });
    expect(JSON.parse(publicSpeechRelayReports(log, false))).toEqual({
      phase: "speech-relay-live",
      status: "passed",
      consentMs: 20,
      sessionMs: 60,
      wsReadyMs: 40,
      bootstrapMs: 120,
      ttsStartupMs: 120,
      firstPcmMs: 240,
      sttTailMs: 1280,
      pcmBytes: 1024,
    });
    expect(JSON.parse(publicSpeechRelayReports(log, true))).toEqual({
      phase: "speech-relay-live",
      status: "failed",
      stage: "unknown",
      code: "SPEECH_CONTRACT_FAILED",
    });
    expect(publicSpeechRelayReports("private-token\nnot JSON", false)).toBe("");
    const invalidTimings = JSON.stringify({
      phase: "speech-relay-live",
      status: "passed",
      consentMs: null,
      sessionMs: -1,
      wsReadyMs: "private-token",
      ttsStartupMs: true,
      sttTailMs: Number.POSITIVE_INFINITY,
    });
    expect(JSON.parse(publicSpeechRelayReports(invalidTimings, false))).toEqual(
      {
        phase: "speech-relay-live",
        status: "passed",
      },
    );
  });

  test("the workflow CLI prints the safe report rather than the private file", () => {
    const directory = mkdtempSync(join(tmpdir(), "speech-live-report-"));
    try {
      const file = join(directory, "private.log");
      writeFileSync(
        file,
        [
          "Authorization: Bearer private-token",
          JSON.stringify({
            phase: "speech-relay-live",
            status: "failed",
            stage: "ready",
            code: "SPEECH_READY_TIMEOUT",
            token: "private-token",
          }),
        ].join("\n"),
      );
      const result = spawnSync(
        process.execPath,
        [
          new URL("../test/speech-relay-live-report.ts", import.meta.url)
            .pathname,
          file,
          "1",
        ],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        phase: "speech-relay-live",
        status: "failed",
        stage: "ready",
        code: "SPEECH_READY_TIMEOUT",
      });
      expect(result.stdout + result.stderr).not.toContain("private-token");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test("server bootstrap spans keep only known numeric durations", () => {
    expect(
      speechServerTimings(
        "session",
        "speech_identity_rate;dur=812.4, speech_consent_consume;dur=40, speech_directory_write;dur=2101.6, entry_dispatch;dur=3000, token;desc=secret",
      ),
    ).toEqual({
      sessionAuthMs: 812,
      sessionConsumeMs: 40,
      sessionRelayInitMs: 2102,
    });
    expect(
      speechServerTimings(
        "consent",
        "speech_identity_rate;dur=-1, speech_consent_write;dur=abc",
      ),
    ).toEqual({});
    expect(speechServerTimings("consent", null)).toEqual({});
    expect(
      speechRelayPhases({
        t: "timings",
        claimMs: 3,
        revocationMs: 410,
        admissionMs: 380,
        relayMs: 395,
        activateMs: 4,
        openMs: 812,
        token: "private",
        bad: Number.NaN,
        negative: -1,
      }),
    ).toEqual({
      relayClaimMs: 3,
      relayRevocationMs: 410,
      relayAdmissionMs: 380,
      relaySessionMs: 395,
      relayActivateMs: 4,
      relayOpenMs: 812,
    });
  });

  test("public reports keep server span fields from a passed run", () => {
    const report = publicSpeechRelayReports(
      JSON.stringify({
        phase: "speech-relay-live",
        status: "passed",
        sessionRelayInitMs: 2102,
        relayOpenMs: 812,
        wsOpenMs: 1500,
        privateText: "never",
      }),
      false,
    );
    expect(report).toContain('"sessionRelayInitMs":2102');
    expect(report).toContain('"relayOpenMs":812');
    expect(report).toContain('"wsOpenMs":1500');
    expect(report).not.toContain("privateText");
  });
});
