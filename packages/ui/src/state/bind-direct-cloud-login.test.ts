/** Verifies direct Cloud login becomes a durable personal-agent binding. */
// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveProfile } from "./agent-profiles";
import { bindDirectCloudLoginToPersonalAgent } from "./bind-direct-cloud-login";
import { loadPersistedActiveServer } from "./persistence";

const PERSONAL_ID = "personal:00000000-0000-5000-8000-000000000001";
const API_BASE =
  "https://api.eliza.app/api/v1/eliza/agents/personal%3A00000000-0000-5000-8000-000000000001";

describe("bindDirectCloudLoginToPersonalAgent", () => {
  beforeEach(() => localStorage.clear());

  it("replaces a stale staging target and repoints the live client", async () => {
    localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: "cloud:old",
        kind: "cloud",
        label: "Staging",
        apiBase: "https://api-staging.eliza.app/api/v1/eliza/agents/old",
        accessToken: "stale",
      }),
    );
    const client = {
      getPersonalSharedEliza: vi.fn(async () => ({
        personalElizaId: PERSONAL_ID,
        activeAgentId: PERSONAL_ID,
        agentName: "Eliza",
        apiBase: API_BASE,
        runtime: "shared" as const,
      })),
      setBaseUrl: vi.fn(),
      setToken: vi.fn(),
    };

    await bindDirectCloudLoginToPersonalAgent({
      client,
      cloudApiBase: "https://api.eliza.app",
      token: "production-token",
    });

    expect(loadPersistedActiveServer()).toMatchObject({
      id: `cloud:${PERSONAL_ID}`,
      apiBase: API_BASE,
      accessToken: "production-token",
      cloudRuntime: "shared",
    });
    expect(getActiveProfile()).toMatchObject({
      cloudAgentId: PERSONAL_ID,
      apiBase: API_BASE,
      accessToken: "production-token",
    });
    expect(client.setBaseUrl).toHaveBeenCalledWith(API_BASE, {
      persist: false,
    });
    expect(client.setToken).toHaveBeenCalledWith("production-token");
  });
});
