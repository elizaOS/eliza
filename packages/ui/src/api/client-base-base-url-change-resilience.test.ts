/**
 * ElizaClient.onBaseUrlChange resilience (#18542): a throwing listener must
 * not block delivery to other listeners, must not block repointBaseUrl's
 * reconnect/token-sync, and a persistence failure in setBaseUrl must not
 * suppress the notification since the in-memory base already changed.
 * Dedicated cloud-agent hosts are used throughout so the client is
 * connected-over-REST and never attempts a real WebSocket. jsdom harness.
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBootConfig } from "../config/boot-config";
import { clearPersistedActiveServer } from "../state/persistence";
import { ElizaClient } from "./client-base";

const AGENT_BASE_A =
  "https://11111111-1111-1111-1111-111111111111.staging.elizacloud.ai";
const AGENT_BASE_B =
  "https://22222222-2222-2222-2222-222222222222.staging.elizacloud.ai";

describe("ElizaClient.onBaseUrlChange resilience", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
    localStorage.clear();
    clearPersistedActiveServer();
  });

  afterEach(() => {
    localStorage.clear();
    clearPersistedActiveServer();
    vi.restoreAllMocks();
  });

  it("isolates a throwing listener so a later listener still fires", () => {
    const client = new ElizaClient(AGENT_BASE_A, "token");
    const seen: string[] = [];
    client.onBaseUrlChange(() => {
      throw new Error("boom");
    });
    client.onBaseUrlChange((baseUrl) => {
      seen.push(baseUrl);
    });

    client.setBaseUrl(AGENT_BASE_B);

    expect(seen).toEqual([AGENT_BASE_B]);
  });

  it("repointBaseUrl still reconnects and dispatches token-sync despite a throwing onBaseUrlChange listener", () => {
    const client = new ElizaClient(AGENT_BASE_A, "token");
    client.onBaseUrlChange(() => {
      throw new Error("boom");
    });

    const tokenSyncHandler = vi.fn();
    window.addEventListener("steward-token-sync", tokenSyncHandler);
    try {
      client.repointBaseUrl(AGENT_BASE_B, "new-token");
    } finally {
      window.removeEventListener("steward-token-sync", tokenSyncHandler);
    }

    expect(client.getBaseUrl()).toBe(AGENT_BASE_B);
    expect(tokenSyncHandler).toHaveBeenCalledTimes(1);
    // Connected-over-REST for a dedicated cloud-agent host: reaching
    // "connected" (rather than getting stuck mid-teardown) proves
    // connectWs() ran to completion after the throwing listener.
    expect(client.getConnectionState().state).toBe("connected");
  });

  it("setBaseUrl still notifies listeners when persistBaseUrl throws (storage failure)", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const client = new ElizaClient(AGENT_BASE_A, "token");
    const seen: string[] = [];
    client.onBaseUrlChange((baseUrl) => {
      seen.push(baseUrl);
    });

    client.setBaseUrl(AGENT_BASE_B);

    // The in-memory base is authoritative even though persistence failed.
    expect(client.getBaseUrl()).toBe(AGENT_BASE_B);
    expect(seen).toEqual([AGENT_BASE_B]);
  });
});
