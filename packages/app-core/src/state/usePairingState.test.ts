// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistPairedToken } from "./usePairingState";

describe("persistPairedToken", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("persists the paired token on the active server and profile", () => {
    window.localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: "remote:http://127.0.0.1:31337",
        kind: "remote",
        label: "Remote agent",
        apiBase: "http://127.0.0.1:31337",
      }),
    );
    window.localStorage.setItem(
      "elizaos:agent-profiles",
      JSON.stringify({
        version: 1,
        activeProfileId: "profile-1",
        profiles: [
          {
            id: "profile-1",
            kind: "remote",
            label: "Remote agent",
            apiBase: "http://127.0.0.1:31337",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );

    persistPairedToken("paired-token");

    expect(
      JSON.parse(window.localStorage.getItem("elizaos:active-server") ?? "{}")
        .accessToken,
    ).toBe("paired-token");
    const registry = JSON.parse(
      window.localStorage.getItem("elizaos:agent-profiles") ?? "{}",
    ) as { profiles?: Array<{ accessToken?: string }> };
    expect(registry.profiles?.[0]?.accessToken).toBe("paired-token");
  });
});
