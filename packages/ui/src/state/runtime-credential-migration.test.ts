/** @vitest-environment jsdom */
/** Verifies legacy browser bearers are moved behind opaque secure references. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgentProfileRegistry } from "./agent-profiles";
import { loadPersistedActiveServer } from "./persistence";
import { migrateLegacyRuntimeCredentials } from "./runtime-credential-migration";

const { storeRuntimeCredential } = vi.hoisted(() => ({
  storeRuntimeCredential: vi.fn().mockResolvedValue("secure"),
}));
vi.mock("../platform/runtime-credential-store", () => ({
  storeRuntimeCredential,
}));

describe("migrateLegacyRuntimeCredentials", () => {
  beforeEach(() => {
    localStorage.clear();
    storeRuntimeCredential.mockClear();
  });

  it("moves profile and active-server tokens then scrubs browser storage", async () => {
    localStorage.setItem(
      "elizaos:agent-profiles",
      JSON.stringify({
        version: 1,
        activeProfileId: "vps-1",
        profiles: [
          {
            id: "vps-1",
            label: "VPS",
            kind: "remote",
            apiBase: "https://host.example.ts.net",
            accessToken: "profile-secret",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: "remote:https://host.example.ts.net",
        label: "VPS",
        kind: "remote",
        apiBase: "https://host.example.ts.net",
        accessToken: "active-secret",
      }),
    );

    await migrateLegacyRuntimeCredentials();

    expect(storeRuntimeCredential).toHaveBeenCalledWith(
      "vps-1",
      "profile-secret",
    );
    expect(storeRuntimeCredential).toHaveBeenCalledWith(
      "vps-1",
      "active-secret",
    );
    expect(loadAgentProfileRegistry().profiles[0]).toMatchObject({
      credentialRef: "vps-1",
    });
    expect(loadAgentProfileRegistry().profiles[0]?.accessToken).toBeUndefined();
    expect(loadPersistedActiveServer()).toMatchObject({
      credentialRef: "vps-1",
    });
    expect(loadPersistedActiveServer()?.accessToken).toBeUndefined();
    expect(localStorage.getItem("elizaos:agent-profiles")).not.toContain(
      "profile-secret",
    );
    expect(localStorage.getItem("elizaos:active-server")).not.toContain(
      "active-secret",
    );
  });

  it("does not scrub if secure persistence fails", async () => {
    storeRuntimeCredential.mockRejectedValueOnce(new Error("keychain denied"));
    localStorage.setItem(
      "elizaos:agent-profiles",
      JSON.stringify({
        version: 1,
        activeProfileId: "vps-1",
        profiles: [
          {
            id: "vps-1",
            label: "VPS",
            kind: "remote",
            accessToken: "keep-until-safe",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    await expect(migrateLegacyRuntimeCredentials()).rejects.toThrow(
      "keychain denied",
    );
    expect(loadAgentProfileRegistry().profiles[0]?.accessToken).toBe(
      "keep-until-safe",
    );
  });
});
