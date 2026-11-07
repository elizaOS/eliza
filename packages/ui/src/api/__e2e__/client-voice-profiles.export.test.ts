/**
 * `VoiceProfilesClient.exportAll` accepts only the export document the server
 * builds; anything else (including the legacy `{ downloadUrl }` envelope) is
 * an unavailable-endpoint failure, never a successful export.
 */
import { describe, expect, it } from "vitest";
import {
  VOICE_PROFILES_EXPORT_SCHEMA,
  VoiceProfilesClient,
  VoiceProfilesUnavailableError,
} from "../client-voice-profiles";

function clientReturning(body: unknown): VoiceProfilesClient {
  return new VoiceProfilesClient({
    fetch: async <T>() => body as T,
  });
}

const VALID = {
  schema: VOICE_PROFILES_EXPORT_SCHEMA,
  exportedAt: "2026-10-10T00:00:00.000Z",
  ownerEntityId: "owner-1",
  profiles: [{ id: "p1" }],
};

describe("VoiceProfilesClient.exportAll", () => {
  it("returns the export document unchanged", async () => {
    await expect(clientReturning(VALID).exportAll()).resolves.toEqual(VALID);
    const noOwner = { ...VALID, ownerEntityId: null };
    await expect(clientReturning(noOwner).exportAll()).resolves.toEqual(
      noOwner,
    );
  });

  it("posts to the export route", async () => {
    const calls: Array<{ path: string; method?: string }> = [];
    const client = new VoiceProfilesClient({
      fetch: async <T>(path: string, init?: RequestInit) => {
        calls.push({ path, method: init?.method });
        return VALID as T;
      },
    });
    await client.exportAll();
    expect(calls).toEqual([
      { path: "/api/voice/profiles/export", method: "POST" },
    ]);
  });

  it.each([
    ["the legacy downloadUrl envelope", { downloadUrl: "data:text/plain,x" }],
    ["a wrong schema tag", { ...VALID, schema: "other.v1" }],
    ["a non-string exportedAt", { ...VALID, exportedAt: 1 }],
    ["a non-string ownerEntityId", { ...VALID, ownerEntityId: 123 }],
    ["a missing ownerEntityId", { ...VALID, ownerEntityId: undefined }],
    ["non-array profiles", { ...VALID, profiles: {} }],
    ["null", null],
  ])("rejects %s", async (_label, body) => {
    await expect(clientReturning(body).exportAll()).rejects.toBeInstanceOf(
      VoiceProfilesUnavailableError,
    );
  });

  it("wraps a transport failure", async () => {
    const client = new VoiceProfilesClient({
      fetch: async () => {
        throw new Error("boom");
      },
    });
    await expect(client.exportAll()).rejects.toThrow(/boom/);
  });
});
