/** Verifies VoiceProfilesClient hops pass timeoutMs through ElizaClient.fetch. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  VOICE_PROFILES_APPEND_FETCH_TIMEOUT_MS,
  VOICE_PROFILES_FAMILY_FETCH_TIMEOUT_MS,
  VOICE_PROFILES_FINALIZE_FETCH_TIMEOUT_MS,
  VOICE_PROFILES_LIST_FETCH_TIMEOUT_MS,
  VOICE_PROFILES_MUTATION_FETCH_TIMEOUT_MS,
  VOICE_PROFILES_START_FETCH_TIMEOUT_MS,
  VoiceProfilesClient,
  VoiceProfilesUnavailableError,
} from "./client-voice-profiles";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

function makeClient() {
  return new VoiceProfilesClient({ fetch: fetchMock });
}

describe("VoiceProfilesClient native-complete deadlines", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("keeps a documented budget per hop", () => {
    expect(VOICE_PROFILES_LIST_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(VOICE_PROFILES_START_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(VOICE_PROFILES_APPEND_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(VOICE_PROFILES_FINALIZE_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(VOICE_PROFILES_FAMILY_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(VOICE_PROFILES_MUTATION_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("passes list timeoutMs through client.fetch", async () => {
    fetchMock.mockResolvedValue({ profiles: [] });
    await makeClient().list();
    expect(fetchMock).toHaveBeenCalledWith("/api/voice/profiles", undefined, {
      timeoutMs: VOICE_PROFILES_LIST_FETCH_TIMEOUT_MS,
    });
  });

  it("passes first-run start timeoutMs through client.fetch", async () => {
    fetchMock.mockResolvedValue({
      sessionId: "s1",
      prompts: [{ id: "p1", text: "Say hi", targetSeconds: 5 }],
    });
    await makeClient().startOwnerCapture();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice/first-run/profile/start",
      { method: "POST" },
      { timeoutMs: VOICE_PROFILES_START_FETCH_TIMEOUT_MS },
    );
  });

  it("passes first-run append timeoutMs through client.fetch", async () => {
    fetchMock.mockResolvedValue({});
    await makeClient().appendOwnerCapture("s1", {
      promptId: "p1",
      audioBase64: "YQ==",
      durationMs: 1,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice/first-run/profile/append?id=s1",
      {
        method: "POST",
        body: JSON.stringify({
          promptId: "p1",
          audioBase64: "YQ==",
          durationMs: 1,
        }),
      },
      { timeoutMs: VOICE_PROFILES_APPEND_FETCH_TIMEOUT_MS },
    );
  });

  it("passes first-run finalize timeoutMs through client.fetch", async () => {
    fetchMock.mockResolvedValue({
      profileId: "p1",
      entityId: "e1",
      isOwner: true,
    });
    await makeClient().finalizeOwnerCapture("s1", { displayName: "Shaw" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice/first-run/profile/finalize?id=s1",
      {
        method: "POST",
        body: JSON.stringify({ displayName: "Shaw" }),
      },
      { timeoutMs: VOICE_PROFILES_FINALIZE_FETCH_TIMEOUT_MS },
    );
  });

  it("passes family-member timeoutMs through client.fetch", async () => {
    fetchMock.mockResolvedValue({
      profileId: "vp_1",
      entityId: "ent-fam",
      displayName: "Alex",
      relationship: "spouse",
      relationshipTag: "family_of",
      ownerEntityId: null,
    });
    await makeClient().captureFamilyMember({
      audioBase64: "dGVzdA==",
      durationMs: 5000,
      displayName: "Alex",
      relationship: "spouse",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/voice/first-run/family-member",
      {
        method: "POST",
        body: JSON.stringify({
          audioBase64: "dGVzdA==",
          durationMs: 5000,
          displayName: "Alex",
          relationship: "spouse",
        }),
        headers: { "content-type": "application/json" },
      },
      { timeoutMs: VOICE_PROFILES_FAMILY_FETCH_TIMEOUT_MS },
    );
  });

  it("passes profile patch timeoutMs through client.fetch", async () => {
    fetchMock.mockResolvedValue({});
    await makeClient().patch("p1", { displayName: "Shaw" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice/profiles/p1",
      {
        method: "PATCH",
        body: JSON.stringify({ displayName: "Shaw" }),
      },
      { timeoutMs: VOICE_PROFILES_MUTATION_FETCH_TIMEOUT_MS },
    );
  });

  it("aborts a stalled append hop as TimeoutError", async () => {
    const timeout = Object.assign(new Error("Request timed out after 10ms"), {
      name: "ApiError",
      kind: "timeout",
    });
    fetchMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(timeout), 10);
        }),
    );
    await expect(
      makeClient().appendOwnerCapture(
        "s1",
        { promptId: "p1", audioBase64: "YQ==", durationMs: 1 },
        10,
      ),
    ).rejects.toBeInstanceOf(VoiceProfilesUnavailableError);
  });

  it("surfaces a provider error from a completed list GET", async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error("Voice profiles request failed (503)"), {
        name: "ApiError",
        kind: "http",
        status: 503,
      }),
    );
    await expect(makeClient().list()).rejects.toMatchObject({
      name: "VoiceProfilesUnavailableError",
    });
  });
});
