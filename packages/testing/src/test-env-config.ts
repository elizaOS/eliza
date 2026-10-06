/**
 * Canonical names of the environment variables that drive end-to-end test
 * phases (ACME client creds, phase2/phase3 knobs, …). Centralized so tests and
 * their harnesses reference one authoritative set of env var names.
 */
export type TestEnvRecord = Record<string, string | undefined>;

export const TEST_ENV_NAMES = {
  acmeClient: {
    clientId: "ELIZA_ACME_CLIENT_ID",
    clientSecret: "ELIZA_ACME_CLIENT_SECRET",
  },
  phase2: {
    sendTestMessage: "ELIZA_PHASE2_SEND_TEST_MESSAGE",
    stopAfter: "ELIZA_PHASE2_STOP_AFTER",
  },
  phase3: {
    sendStreamMessage: "ELIZA_PHASE3_SEND_STREAM_MESSAGE",
    cancelAfterMs: "ELIZA_PHASE3_CANCEL_AFTER_MS",
    stopAfter: "ELIZA_PHASE3_STOP_AFTER",
  },
  voiceE2e: {
    bundle: "ELIZA_VOICE_E2E_BUNDLE",
    dylib: "ELIZA_VOICE_E2E_DYLIB",
    backend: "ELIZA_VOICE_E2E_BACKEND",
    cases: "ELIZA_VOICE_E2E_CASES",
    phrase: "ELIZA_VOICE_E2E_PHRASE",
    report: "ELIZA_VOICE_E2E_REPORT",
    audioDir: "ELIZA_VOICE_E2E_AUDIO_DIR",
    maxWer: "ELIZA_VOICE_E2E_MAX_WER",
    maxBargeMs: "ELIZA_VOICE_E2E_MAX_BARGE_MS",
    maxFirstAudioMs: "ELIZA_VOICE_E2E_MAX_FIRST_AUDIO_MS",
    eventsJson: "ELIZA_VOICE_E2E_EVENTS_JSON",
    latencyBase: "ELIZA_VOICE_E2E_LATENCY_BASE",
    allowTtsOnlyBargeIn: "ELIZA_VOICE_E2E_ALLOW_TTS_ONLY_BARGE_IN",
  },
} as const;

export const TEST_ENV_FAMILIES = {
  acmeClient: [
    TEST_ENV_NAMES.acmeClient.clientId,
    TEST_ENV_NAMES.acmeClient.clientSecret,
  ],
  phase2: [
    TEST_ENV_NAMES.phase2.sendTestMessage,
    TEST_ENV_NAMES.phase2.stopAfter,
  ],
  phase3: [
    TEST_ENV_NAMES.phase3.sendStreamMessage,
    TEST_ENV_NAMES.phase3.cancelAfterMs,
    TEST_ENV_NAMES.phase3.stopAfter,
  ],
  voiceE2e: [
    TEST_ENV_NAMES.voiceE2e.bundle,
    TEST_ENV_NAMES.voiceE2e.dylib,
    TEST_ENV_NAMES.voiceE2e.backend,
    TEST_ENV_NAMES.voiceE2e.cases,
    TEST_ENV_NAMES.voiceE2e.phrase,
    TEST_ENV_NAMES.voiceE2e.report,
    TEST_ENV_NAMES.voiceE2e.audioDir,
    TEST_ENV_NAMES.voiceE2e.maxWer,
    TEST_ENV_NAMES.voiceE2e.maxBargeMs,
    TEST_ENV_NAMES.voiceE2e.maxFirstAudioMs,
    TEST_ENV_NAMES.voiceE2e.eventsJson,
    TEST_ENV_NAMES.voiceE2e.latencyBase,
    TEST_ENV_NAMES.voiceE2e.allowTtsOnlyBargeIn,
  ],
} as const;

export type TestEnvFamily = keyof typeof TEST_ENV_FAMILIES;

export interface AcmeClientTestEnv {
  clientId: string;
  clientSecret: string;
}

export interface Phase2SmokeTestEnv {
  sendTestMessage: boolean;
  stopAfter: boolean;
}

export interface Phase3SmokeTestEnv {
  sendStreamMessage: boolean;
  cancelAfterMs: number | null;
  stopAfter: boolean;
}

export interface VoiceE2eTestEnvDefaults {
  backend: string;
  cases: string;
  phrase: string;
  maxWer: number;
  maxBargeMs: number;
  maxFirstAudioMs: number;
}

export interface VoiceE2eTestEnv {
  bundle: string;
  dylib: string;
  backend: string;
  cases: string;
  phrase: string;
  report: string;
  audioDir: string;
  maxWer: number;
  maxBargeMs: number;
  maxFirstAudioMs: number;
  eventsJson: string;
  latencyBase: string;
  allowTtsOnlyBargeIn: boolean;
}

function readEnvValue(env: TestEnvRecord, key: string): string | undefined {
  const value = env[key];
  return value && value.length > 0 ? value : undefined;
}

function readEnvFlag(env: TestEnvRecord, key: string): boolean {
  return env[key] === "1";
}

function readEnvNumber(
  env: TestEnvRecord,
  key: string,
  fallback: number,
): number {
  const value = readEnvValue(env, key);
  return value === undefined ? fallback : Number(value);
}

function readPositiveEnvInt(env: TestEnvRecord, key: string): number | null {
  const value = env[key];
  if (value === undefined || value.trim().length === 0) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function listTestEnvFamilyNames(
  family: TestEnvFamily,
): readonly string[] {
  return TEST_ENV_FAMILIES[family];
}

export function setAcmeClientTestEnv(
  env: TestEnvRecord,
  values: AcmeClientTestEnv = {
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
  },
): void {
  env[TEST_ENV_NAMES.acmeClient.clientId] = values.clientId;
  env[TEST_ENV_NAMES.acmeClient.clientSecret] = values.clientSecret;
}

export function readAcmeClientTestEnv(env: TestEnvRecord): AcmeClientTestEnv {
  return {
    clientId: readEnvValue(env, TEST_ENV_NAMES.acmeClient.clientId) ?? "",
    clientSecret:
      readEnvValue(env, TEST_ENV_NAMES.acmeClient.clientSecret) ?? "",
  };
}

export function readPhase2SmokeTestEnv(env: TestEnvRecord): Phase2SmokeTestEnv {
  return {
    sendTestMessage: readEnvFlag(env, TEST_ENV_NAMES.phase2.sendTestMessage),
    stopAfter: readEnvFlag(env, TEST_ENV_NAMES.phase2.stopAfter),
  };
}

export function readPhase3SmokeTestEnv(env: TestEnvRecord): Phase3SmokeTestEnv {
  return {
    sendStreamMessage: readEnvFlag(
      env,
      TEST_ENV_NAMES.phase3.sendStreamMessage,
    ),
    cancelAfterMs: readPositiveEnvInt(env, TEST_ENV_NAMES.phase3.cancelAfterMs),
    stopAfter: readEnvFlag(env, TEST_ENV_NAMES.phase3.stopAfter),
  };
}

export function readVoiceE2eTestEnv(
  env: TestEnvRecord,
  defaults: VoiceE2eTestEnvDefaults,
): VoiceE2eTestEnv {
  return {
    bundle: readEnvValue(env, TEST_ENV_NAMES.voiceE2e.bundle) ?? "",
    dylib: readEnvValue(env, TEST_ENV_NAMES.voiceE2e.dylib) ?? "",
    backend:
      readEnvValue(env, TEST_ENV_NAMES.voiceE2e.backend) ?? defaults.backend,
    cases: readEnvValue(env, TEST_ENV_NAMES.voiceE2e.cases) ?? defaults.cases,
    phrase:
      readEnvValue(env, TEST_ENV_NAMES.voiceE2e.phrase) ?? defaults.phrase,
    report: readEnvValue(env, TEST_ENV_NAMES.voiceE2e.report) ?? "",
    audioDir: readEnvValue(env, TEST_ENV_NAMES.voiceE2e.audioDir) ?? "",
    maxWer: readEnvNumber(env, TEST_ENV_NAMES.voiceE2e.maxWer, defaults.maxWer),
    maxBargeMs: readEnvNumber(
      env,
      TEST_ENV_NAMES.voiceE2e.maxBargeMs,
      defaults.maxBargeMs,
    ),
    maxFirstAudioMs: readEnvNumber(
      env,
      TEST_ENV_NAMES.voiceE2e.maxFirstAudioMs,
      defaults.maxFirstAudioMs,
    ),
    eventsJson: readEnvValue(env, TEST_ENV_NAMES.voiceE2e.eventsJson) ?? "",
    latencyBase: readEnvValue(env, TEST_ENV_NAMES.voiceE2e.latencyBase) ?? "",
    allowTtsOnlyBargeIn: readEnvFlag(
      env,
      TEST_ENV_NAMES.voiceE2e.allowTtsOnlyBargeIn,
    ),
  };
}
