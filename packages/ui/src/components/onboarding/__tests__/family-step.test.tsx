// @vitest-environment jsdom
/**
 * Integration tests for FamilyStep (step 7 of voice prefix onboarding).
 *
 * Covers:
 *   - Empty list → skip path (no capture needed, Continue works)
 *   - One member → entity created + profile bound (captureFamilyMember called)
 *   - Two members → two distinct entities with different profileIds / entityIds
 *   - Client-side graceful fallback: 404 → stub entityId always returned
 *
 * MediaRecorder is mocked. `recordAudioBlob` uses `setTimeout(stop, DURATION_MS)` so we
 * advance fake timers past 5 000 ms to trigger stop + onstop → blob resolution.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type FamilyMemberCapturePayload,
  type FamilyMemberCaptureResult,
  VoiceProfilesClient,
} from "../../../api/client-voice-profiles";
import { VoicePrefixSteps } from "../VoicePrefixSteps";

// ---------------------------------------------------------------------------
// FakeMediaRecorder — stop() fires onstop synchronously so advancing
// fake timers by DURATION_MS is enough to unblock recordAudioBlob.
// ---------------------------------------------------------------------------

class FakeMediaRecorder {
  static isTypeSupported() {
    return true;
  }
  mimeType = "audio/webm";
  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: Event) => void) | null = null;

  start() {
    this.state = "recording";
    // Deliver audio chunk immediately (via fake-timer-aware setTimeout(fn,0)).
    setTimeout(() => {
      this.ondataavailable?.({
        data: new Blob(["fake-audio"], { type: "audio/webm" }),
      });
    }, 0);
  }

  stop() {
    this.state = "inactive";
    // Fire onstop synchronously so callers waiting on the Promise resolve.
    this.onstop?.();
  }
}

const fakeMicStream = {
  getTracks: () => [{ stop: vi.fn() }],
} as unknown as MediaStream;

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

function makeClient(
  overrides?: Partial<InstanceType<typeof VoiceProfilesClient>>,
) {
  const base = new VoiceProfilesClient({
    fetch: async <T,>(): Promise<T> => ({ profiles: [] }) as T,
  });
  return Object.assign(base, overrides);
}

function makeCaptureResult(
  idx: number,
  payload: FamilyMemberCapturePayload,
): FamilyMemberCaptureResult {
  return {
    profileId: `vp_family_${idx}`,
    entityId: `entity-family-${idx}`,
    displayName: payload.displayName,
    relationship: payload.relationship,
    relationshipTag: "family_of",
    ownerEntityId: payload.ownerEntityId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseProps = {
  tier: "GOOD" as const,
  onAdvance: vi.fn(),
  onBack: vi.fn(),
};

function renderFamilyStep(
  clientOverrides?: Partial<InstanceType<typeof VoiceProfilesClient>>,
) {
  const client = makeClient(clientOverrides);
  render(
    <VoicePrefixSteps {...baseProps} step="family" profilesClient={client} />,
  );
  return { client };
}

/** Fill name, optionally relationship, then click Record and flush timers. */
async function recordMember(name: string, relationship?: string) {
  fireEvent.change(screen.getByTestId("voice-prefix-family-name-input"), {
    target: { value: name },
  });
  if (relationship) {
    fireEvent.change(
      screen.getByTestId("voice-prefix-family-relationship-input"),
      { target: { value: relationship } },
    );
  }

  // Click Record — this calls startCapture which calls recordAudioBlob.
  // recordAudioBlob wraps MediaRecorder in a Promise resolved by onstop,
  // and schedules `setTimeout(recorder.stop, DURATION_MS)`.
  // We need to:
  //  1. Let the click handler run (async) — use act(async).
  //  2. Advance fake timers past 5 000 ms so the timeout fires.
  //  3. Drain the micro-task queue for blobToBase64 + captureFamilyMember.
  await act(async () => {
    fireEvent.click(screen.getByTestId("voice-prefix-family-record"));
  });
  // Advance past DURATION_MS (5 000 ms) and the zero-delay data chunk.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5100);
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();

  // Install MediaRecorder mock.
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);

  // Mock getUserMedia.
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn().mockResolvedValue(fakeMicStream),
    },
  });

  // FileReader mock: returns a deterministic base64 data-URL.
  const FakeFileReader = class {
    result = "data:audio/webm;base64,ZmFrZS1hdWRpbw=="; // "fake-audio"
    onload: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    readAsDataURL() {
      // Fire onload in a microtask so awaiting works naturally.
      Promise.resolve().then(() => this.onload?.());
    }
  };
  vi.stubGlobal("FileReader", FakeFileReader);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FamilyStep", () => {
  it("renders empty state and skip button when no members captured", () => {
    renderFamilyStep();

    expect(
      screen.getByTestId("voice-prefix-family-empty").textContent,
    ).toContain("No additional people");

    // Step is optional — Skip button must be present.
    expect(screen.getByTestId("voice-prefix-skip")).toBeTruthy();
  });

  it("skip / continue without capturing any member advances to next step", () => {
    const onAdvance = vi.fn();
    const client = makeClient();
    render(
      <VoicePrefixSteps
        {...baseProps}
        step="family"
        onAdvance={onAdvance}
        profilesClient={client}
      />,
    );

    fireEvent.click(screen.getByTestId("voice-prefix-continue"));
    expect(onAdvance).toHaveBeenCalledTimes(1);
    // Family is the last step; next is null.
    expect(onAdvance.mock.calls[0]?.[0]).toBeNull();
  });

  it("captures one member: captureFamilyMember called once, list shows 'captured'", async () => {
    let callCount = 0;
    const captureFamilyMember = vi.fn(
      async (
        payload: FamilyMemberCapturePayload,
      ): Promise<FamilyMemberCaptureResult> => {
        callCount += 1;
        return makeCaptureResult(callCount, payload);
      },
    );
    renderFamilyStep({ captureFamilyMember });

    await recordMember("Alex");

    // captureFamilyMember should have been invoked exactly once.
    expect(captureFamilyMember).toHaveBeenCalledTimes(1);

    const payload = captureFamilyMember.mock.calls[0]?.[0];
    expect(payload?.displayName).toBe("Alex");
    expect(payload?.relationship).toBe("family");
    expect(typeof payload?.audioBase64).toBe("string");
    expect(payload?.audioBase64.length).toBeGreaterThan(0);
    expect(payload?.durationMs).toBeGreaterThan(0);

    // The list should show the captured member.
    await waitFor(() =>
      expect(screen.getByTestId("voice-prefix-family-list")).toBeTruthy(),
    );

    // "captured" badge: entityId is non-null → real entity created.
    const capturedBadge = await screen.findByTestId(
      "voice-prefix-family-captured",
    );
    expect(capturedBadge.textContent).toContain("captured");
  });

  it("captures two members: two distinct calls, two entries, two 'captured' badges", async () => {
    let callCount = 0;
    const captureFamilyMember = vi.fn(
      async (
        payload: FamilyMemberCapturePayload,
      ): Promise<FamilyMemberCaptureResult> => {
        callCount += 1;
        return makeCaptureResult(callCount, payload);
      },
    );
    renderFamilyStep({ captureFamilyMember });

    // First member.
    await recordMember("Alex");
    await waitFor(() => expect(captureFamilyMember).toHaveBeenCalledTimes(1));

    // Second member — form has reset to idle by now.
    await recordMember("Jordan", "colleague");
    await waitFor(() => expect(captureFamilyMember).toHaveBeenCalledTimes(2));

    // Two list entries.
    await waitFor(() => {
      const list = screen.getByTestId("voice-prefix-family-list");
      expect(list.children.length).toBe(2);
    });

    // Payloads are distinct.
    const call1 = captureFamilyMember.mock.calls[0]?.[0];
    const call2 = captureFamilyMember.mock.calls[1]?.[0];
    expect(call1?.displayName).toBe("Alex");
    expect(call2?.displayName).toBe("Jordan");
    expect(call2?.relationship).toBe("colleague");

    // Both badges show "captured" (non-null entityIds).
    const captured = screen.getAllByTestId("voice-prefix-family-captured");
    expect(captured.length).toBe(2);
  });

  it("client-side fallback: 404 response yields stub result with family_of tag", async () => {
    const result = await new VoiceProfilesClient({
      fetch: async () => {
        const err = Object.assign(new Error("not found"), { status: 404 });
        throw err;
      },
    }).captureFamilyMember({
      audioBase64: "dGVzdA==",
      durationMs: 5000,
      displayName: "Test",
      relationship: "family",
    });

    // Stub always returns a non-null entityId so the UI can show "captured".
    expect(typeof result.entityId).toBe("string");
    expect(result.entityId.startsWith("family-entity-stub-")).toBe(true);
    expect(result.profileId.startsWith("family-stub-")).toBe(true);
    expect(result.relationshipTag).toBe("family_of");
    expect(result.displayName).toBe("Test");
  });
});
