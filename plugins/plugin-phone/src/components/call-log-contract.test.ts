// External-API contract test for the Phone view data path.
//
// The view-facing data layer (loadPhoneState + interact("terminal-phone-state"))
// consumes the @elizaos/capacitor-phone CallLogEntry shape. This test feeds a
// FULL, real-shaped CallLogEntry — every field declared in
// plugins/plugin-native-phone/src/definitions.ts (CallLogEntry has 15 fields;
// PhoneStatus has 4) — through the real parsers and locks down exactly which
// fields survive into the projected DTO, so a native API field addition cannot
// silently leak into the terminal/view contract.

import { afterEach, describe, expect, it, vi } from "vitest";

const phoneBridge = vi.hoisted(() => ({
  getStatus: vi.fn(),
  listRecentCalls: vi.fn(),
  placeCall: vi.fn(),
  openDialer: vi.fn(),
  saveCallTranscript: vi.fn(),
}));

vi.mock("@elizaos/capacitor-phone", () => ({ Phone: phoneBridge }));

import { loadPhoneState } from "./PhoneAppView.helpers";
import { interact } from "./PhoneAppView.interact";

// Mirrors definitions.ts CallLogEntry exactly (all native fields populated).
const REAL_CALL_LOG_ENTRY = {
  id: "98765",
  number: "+15551234567",
  cachedName: "Grace Hopper",
  date: 1_718_000_000_000,
  durationSeconds: 142,
  type: "voicemail",
  rawType: 4,
  isNew: true,
  phoneAccountId: "sim-1",
  geocodedLocation: "Arlington, VA",
  transcription: "OS-provided voicemail transcription text",
  voicemailUri: "content://call_log/voicemail/98765",
  agentTranscript: "Agent-authored transcript body",
  agentSummary: "Returned the call about the compiler bug.",
  agentTranscriptUpdatedAt: 1_718_000_100_000,
} as const;

const REAL_STATUS = {
  hasTelecom: true,
  canPlaceCalls: true,
  isDefaultDialer: false,
  defaultDialerPackage: "com.android.dialer",
} as const;

afterEach(() => {
  vi.clearAllMocks();
});

describe("phone view data-path contract (real CallLogEntry shape)", () => {
  it("loadPhoneState returns the native status and calls untouched", async () => {
    phoneBridge.getStatus.mockResolvedValue(REAL_STATUS);
    phoneBridge.listRecentCalls.mockResolvedValue({
      calls: [REAL_CALL_LOG_ENTRY],
    });

    const state = await loadPhoneState({ limit: 25 });

    expect(phoneBridge.listRecentCalls).toHaveBeenCalledWith({ limit: 25 });
    expect(state.status).toEqual(REAL_STATUS);
    // loadPhoneState does not re-shape entries.
    expect(state.calls).toEqual([REAL_CALL_LOG_ENTRY]);
  });

  it("terminal-phone-state projects only view-facing fields and drops native-only ones", async () => {
    phoneBridge.getStatus.mockResolvedValue(REAL_STATUS);
    phoneBridge.listRecentCalls.mockResolvedValue({
      calls: [REAL_CALL_LOG_ENTRY],
    });

    const result = (await interact("terminal-phone-state", {
      limit: 10,
    })) as {
      viewType: string;
      status: typeof REAL_STATUS;
      calls: Array<Record<string, unknown>>;
    };

    expect(result.viewType).toBe("tui");
    expect(result.status).toEqual(REAL_STATUS);
    expect(result.calls).toHaveLength(1);

    const projected = result.calls[0];
    // Exact projected key set — adding/removing a key here is a contract change.
    expect(Object.keys(projected).sort()).toEqual(
      [
        "agentSummary",
        "agentTranscript",
        "cachedName",
        "date",
        "durationSeconds",
        "id",
        "isNew",
        "label",
        "number",
        "type",
      ].sort(),
    );

    // Surviving values match the native source.
    expect(projected).toMatchObject({
      id: "98765",
      number: "+15551234567",
      cachedName: "Grace Hopper",
      label: "Grace Hopper", // derived from cachedName
      date: 1_718_000_000_000,
      durationSeconds: 142,
      type: "voicemail",
      isNew: true,
      agentSummary: "Returned the call about the compiler bug.",
      agentTranscript: "Agent-authored transcript body",
    });

    // Native-only fields must NOT leak into the view contract.
    for (const native of [
      "rawType",
      "phoneAccountId",
      "geocodedLocation",
      "transcription",
      "voicemailUri",
      "agentTranscriptUpdatedAt",
    ]) {
      expect(projected).not.toHaveProperty(native);
    }
  });

  it("falls back to the raw number for the label when cachedName is null", async () => {
    phoneBridge.getStatus.mockResolvedValue(REAL_STATUS);
    phoneBridge.listRecentCalls.mockResolvedValue({
      calls: [{ ...REAL_CALL_LOG_ENTRY, cachedName: null }],
    });

    const result = (await interact("terminal-phone-state")) as {
      calls: Array<{ label: string; cachedName: string | null }>;
    };
    expect(result.calls[0].cachedName).toBeNull();
    expect(result.calls[0].label).toBe("+15551234567");
  });
});
