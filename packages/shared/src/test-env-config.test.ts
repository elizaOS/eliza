/**
 * Covers the test-only env catalog in `test-env-config.ts`: the tracked
 * TEST_ENV_FAMILIES/TEST_ENV_NAMES enumeration, the acme fixture credential
 * accessors, phase2/phase3 smoke-flag normalization, and voice-E2E default
 * merging. Runs over in-memory TestEnvRecord objects, never real process.env.
 */
import { describe, expect, it } from "vitest";
import {
  listTestEnvFamilyNames,
  readAcmeClientTestEnv,
  readPhase2SmokeTestEnv,
  readPhase3SmokeTestEnv,
  readVoiceE2eTestEnv,
  setAcmeClientTestEnv,
  TEST_ENV_FAMILIES,
  TEST_ENV_NAMES,
  type TestEnvRecord,
} from "./test-env-config.js";

describe("test env config catalog", () => {
  it("enumerates the tracked test-only env families", () => {
    expect(TEST_ENV_FAMILIES.acmeClient).toEqual([
      "ELIZA_ACME_CLIENT_ID",
      "ELIZA_ACME_CLIENT_SECRET",
    ]);
    expect(TEST_ENV_FAMILIES.phase2).toEqual([
      "ELIZA_PHASE2_SEND_TEST_MESSAGE",
      "ELIZA_PHASE2_STOP_AFTER",
    ]);
    expect(TEST_ENV_FAMILIES.phase3).toEqual([
      "ELIZA_PHASE3_SEND_STREAM_MESSAGE",
      "ELIZA_PHASE3_CANCEL_AFTER_MS",
      "ELIZA_PHASE3_STOP_AFTER",
    ]);
    expect(TEST_ENV_FAMILIES.voiceE2e).toContain(
      "ELIZA_VOICE_E2E_ALLOW_TTS_ONLY_BARGE_IN",
    );
    expect(listTestEnvFamilyNames("voiceE2e")).toHaveLength(13);
  });

  it("reads the health acme fixture credentials from the catalog", () => {
    const env: TestEnvRecord = {};

    setAcmeClientTestEnv(env);

    expect(readAcmeClientTestEnv(env)).toEqual({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
    });
  });

  it("normalizes phase smoke flags and optional cancel timing", () => {
    const env: TestEnvRecord = {
      [TEST_ENV_NAMES.phase2.sendTestMessage]: "1",
      [TEST_ENV_NAMES.phase2.stopAfter]: "0",
      [TEST_ENV_NAMES.phase3.sendStreamMessage]: "1",
      [TEST_ENV_NAMES.phase3.cancelAfterMs]: "250",
      [TEST_ENV_NAMES.phase3.stopAfter]: "1",
    };

    expect(readPhase2SmokeTestEnv(env)).toEqual({
      sendTestMessage: true,
      stopAfter: false,
    });
    expect(readPhase3SmokeTestEnv(env)).toEqual({
      sendStreamMessage: true,
      cancelAfterMs: 250,
      stopAfter: true,
    });
  });

  it("applies voice E2E defaults while preserving explicit env values", () => {
    const env: TestEnvRecord = {
      [TEST_ENV_NAMES.voiceE2e.bundle]: "/tmp/model.bundle",
      [TEST_ENV_NAMES.voiceE2e.maxWer]: "0.2",
      [TEST_ENV_NAMES.voiceE2e.allowTtsOnlyBargeIn]: "1",
    };

    expect(
      readVoiceE2eTestEnv(env, {
        backend: "metal",
        cases: "roundtrip",
        phrase: "hello",
        maxWer: 0.15,
        maxBargeMs: 250,
        maxFirstAudioMs: 1500,
      }),
    ).toMatchObject({
      bundle: "/tmp/model.bundle",
      backend: "metal",
      cases: "roundtrip",
      phrase: "hello",
      maxWer: 0.2,
      maxBargeMs: 250,
      maxFirstAudioMs: 1500,
      allowTtsOnlyBargeIn: true,
    });
  });
});
