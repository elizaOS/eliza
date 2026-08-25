/**
 * Keyless catalog coverage for the SETTINGS voice section and its payload
 * contract (#16942). Runs on the pr-deterministic lane; settings-voice-toggle
 * (plugins/plugin-app-control/test/scenarios) proves a real model drives the
 * same path from natural phrasing.
 *
 * Exercises the real SETTINGS handler end to end against the loopback config
 * API: continuous-chat on, silence window, RMS threshold, continuous-chat off,
 * plus the invalid-mode and out-of-range rejections. The final checks pin the
 * exact ordered `PUT /api/config` persisted-prefs ledger and the matching
 * `voice-settings:apply` broadcast ledger — including the #14910 twin
 * invariant that a write seeding an empty voice config persists exactly the
 * defaults the Voice settings UI applies (silenceMs 650, speechRmsThreshold
 * 0.003) — proving the emitted payload contract, not just handler success.
 */
import type { ScenarioTurnExecution } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { VOICE_SETTINGS_APPLY_EVENT } from "@elizaos/shared";
import {
  jsonResponse,
  readAppControlHttpRequests,
  registerAppControlHttpHandler,
  resetAppControlHttpLoopback,
} from "./_helpers/app-control-http-loopback";

type JsonRecord = Record<string, unknown>;

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

// Stateful stand-in for the real config route so consecutive writes prove
// cumulative state: each turn's PUT must preserve what earlier turns persisted.
let configState: { messages: JsonRecord } = { messages: {} };

function voiceConfigWrites(): unknown[] {
  return readAppControlHttpRequests(
    (request) => request.method === "PUT" && request.pathname === "/api/config",
  ).map((request) => request.body ?? null);
}

function voiceApplyBroadcasts(): unknown[] {
  return readAppControlHttpRequests(
    (request) =>
      request.method === "POST" &&
      request.pathname === "/api/views/events/broadcast" &&
      toRecord(request.body).type === VOICE_SETTINGS_APPLY_EVENT,
  ).map((request) => toRecord(request.body).payload ?? null);
}

function expectSettingsTurn(
  execution: ScenarioTurnExecution,
  expected: { success: boolean; responseText: string },
): string | undefined {
  if (execution.responseText !== expected.responseText) {
    return `expected responseText=${JSON.stringify(expected.responseText)}, saw ${JSON.stringify(execution.responseText)}`;
  }
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === "SETTINGS",
  );
  if (!action) {
    return `expected SETTINGS action, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`;
  }
  if (action.result?.success !== expected.success) {
    return `expected SETTINGS result.success=${expected.success}, saw ${JSON.stringify(action.result)}`;
  }
  return undefined;
}

// #14910 twin invariant defaults (see DEFAULT_VOICE_SETTINGS_PREFS in
// plugins/plugin-app-control/src/actions/settings.ts).
const TWIN_DEFAULT_SILENCE_MS = 650;
const TWIN_DEFAULT_RMS = 0.003;

// The exact prefs each successful write must persist AND broadcast, in turn
// order: on → silence 1200 → rms 0.008 → off. Rejected turns write nothing.
const EXPECTED_PREFS_LEDGER = [
  {
    continuous: "always-on",
    osIntentAutoStartVoice: false,
    osIntentAutoStartTranscription: false,
    vadAutoStop: {
      silenceMs: TWIN_DEFAULT_SILENCE_MS,
      speechRmsThreshold: TWIN_DEFAULT_RMS,
    },
  },
  {
    continuous: "always-on",
    osIntentAutoStartVoice: false,
    osIntentAutoStartTranscription: false,
    vadAutoStop: { silenceMs: 1200, speechRmsThreshold: TWIN_DEFAULT_RMS },
  },
  {
    continuous: "always-on",
    osIntentAutoStartVoice: false,
    osIntentAutoStartTranscription: false,
    vadAutoStop: { silenceMs: 1200, speechRmsThreshold: 0.008 },
  },
  {
    continuous: "off",
    osIntentAutoStartVoice: false,
    osIntentAutoStartTranscription: false,
    vadAutoStop: { silenceMs: 1200, speechRmsThreshold: 0.008 },
  },
];

export default scenario({
  id: "deterministic-settings-voice-actions",
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "model-free",
    reason:
      "Direct action turns exercise runtime contracts without model calls.",
  },
  title: "Deterministic SETTINGS voice-section payload contract",
  domain: "scenario-runner",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "app-control",
    "settings",
    "voice",
  ],
  isolation: "shared-runtime",
  requires: {
    plugins: ["@elizaos/plugin-app-control"],
  },
  seed: [
    {
      type: "custom",
      name: "register config + broadcast loopback API",
      apply: () => {
        resetAppControlHttpLoopback();
        configState = { messages: {} };
        registerAppControlHttpHandler((request) => {
          if (request.method === "GET" && request.pathname === "/api/config") {
            return jsonResponse(configState);
          }
          if (request.method === "PUT" && request.pathname === "/api/config") {
            configState = {
              messages: toRecord(toRecord(request.body).messages),
            };
            return jsonResponse({ ok: true });
          }
          if (
            request.method === "POST" &&
            request.pathname === "/api/views/events/broadcast"
          ) {
            return jsonResponse({ ok: true, delivered: 1 });
          }
          return undefined;
        });
        return undefined;
      },
    },
  ],
  rooms: [
    {
      id: "main",
      source: "client_chat",
      title: "Deterministic Settings Voice Catalog",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "turn on continuous voice chat",
      text: "turn on continuous voice chat",
      actionName: "SETTINGS",
      options: {
        action: "set",
        section: "voice",
        key: "continuous",
        value: "always-on",
      },
      assertTurn: (execution) =>
        expectSettingsTurn(execution, {
          success: true,
          responseText:
            "Voice settings updated: continuous chat is always-on, voice shortcut auto-start is off, transcription shortcut auto-start is off, silence is 650ms, speech threshold is 0.003.",
        }),
    },
    {
      kind: "action",
      name: "set voice silence window to 1200ms",
      text: "set voice silence to 1200ms",
      actionName: "SETTINGS",
      options: {
        action: "set",
        section: "voice",
        key: "silence-ms",
        value: "1200",
      },
      assertTurn: (execution) =>
        expectSettingsTurn(execution, {
          success: true,
          responseText:
            "Voice settings updated: continuous chat is always-on, voice shortcut auto-start is off, transcription shortcut auto-start is off, silence is 1200ms, speech threshold is 0.003.",
        }),
    },
    {
      kind: "action",
      name: "set voice speech threshold to 0.008",
      text: "make the voice end-of-turn threshold 0.008",
      actionName: "SETTINGS",
      options: {
        action: "set",
        section: "voice",
        key: "rms",
        value: "0.008",
      },
      assertTurn: (execution) =>
        expectSettingsTurn(execution, {
          success: true,
          responseText:
            "Voice settings updated: continuous chat is always-on, voice shortcut auto-start is off, transcription shortcut auto-start is off, silence is 1200ms, speech threshold is 0.008.",
        }),
    },
    {
      kind: "action",
      name: "turn continuous voice chat off",
      text: "turn off hands-free voice",
      actionName: "SETTINGS",
      options: {
        action: "set",
        section: "voice",
        key: "continuous",
        value: "off",
      },
      assertTurn: (execution) =>
        expectSettingsTurn(execution, {
          success: true,
          responseText:
            "Voice settings updated: continuous chat is off, voice shortcut auto-start is off, transcription shortcut auto-start is off, silence is 1200ms, speech threshold is 0.008.",
        }),
    },
    {
      kind: "action",
      name: "reject an unknown continuous-chat mode",
      text: "set voice continuous to sometimes",
      actionName: "SETTINGS",
      options: {
        action: "set",
        section: "voice",
        key: "continuous",
        value: "sometimes",
      },
      assertTurn: (execution) =>
        expectSettingsTurn(execution, {
          success: false,
          responseText:
            "I couldn't change voice continuous: provide value=off|vad-gated|always-on for voice continuous chat.",
        }),
    },
    {
      kind: "action",
      name: "reject an out-of-range silence window",
      text: "set voice silence to 50ms",
      actionName: "SETTINGS",
      options: {
        action: "set",
        section: "voice",
        key: "silence-ms",
        value: "50",
      },
      assertTurn: (execution) =>
        expectSettingsTurn(execution, {
          success: false,
          responseText:
            "I couldn't change voice silence-ms: silenceMs must be between 300 and 3000.",
        }),
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "SETTINGS",
      status: "success",
      minCount: 4,
    },
    {
      type: "custom",
      name: "PUT /api/config persisted-prefs ledger is exact and ordered",
      predicate: () => {
        const expected = EXPECTED_PREFS_LEDGER.map((prefs) => ({
          messages: { voice: prefs },
        }));
        const actual = voiceConfigWrites();
        return JSON.stringify(actual) === JSON.stringify(expected)
          ? undefined
          : `expected voice config write ledger ${JSON.stringify(expected)}, saw ${JSON.stringify(actual)}`;
      },
    },
    {
      type: "custom",
      name: "voice-settings:apply broadcast ledger mirrors the persisted prefs",
      predicate: () => {
        const actual = voiceApplyBroadcasts();
        return JSON.stringify(actual) === JSON.stringify(EXPECTED_PREFS_LEDGER)
          ? undefined
          : `expected voice-settings:apply ledger ${JSON.stringify(EXPECTED_PREFS_LEDGER)}, saw ${JSON.stringify(actual)}`;
      },
    },
    {
      type: "custom",
      name: "cleanup config loopback",
      predicate: () => {
        resetAppControlHttpLoopback();
        return undefined;
      },
    },
  ],
});
