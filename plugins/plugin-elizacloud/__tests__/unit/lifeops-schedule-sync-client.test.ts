import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LifeOpsScheduleSyncClient,
  LifeOpsScheduleSyncClientError,
  normalizeLifeOpsScheduleSyncSecret,
  resolveLifeOpsScheduleSyncConfig,
  resolveLifeOpsScheduleSyncSiteUrl,
} from "../../src/cloud/lifeops-schedule-sync-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LifeOpsScheduleSyncClient", () => {
  it("posts observations to a remote agent with bearer auth", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        acceptedCount: 1,
        mergedState: null,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new LifeOpsScheduleSyncClient(() => ({
      configured: true,
      mode: "remote",
      baseUrl: "https://agent.example/",
      accessToken: "remote-token",
    }));

    await client.syncObservations({
      deviceId: "device-1",
      deviceKind: "mac",
      timezone: "America/Los_Angeles",
      observations: [
        {
          circadianState: "awake",
          stateConfidence: 0.9,
          windowStartAt: "2026-06-01T12:00:00.000Z",
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://agent.example/api/lifeops/schedule/observations",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer remote-token",
          "Content-Type": "application/json",
        }),
      })
    );
  });

  it("reads merged schedule state through the Cloud agent API", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        mergedState: null,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new LifeOpsScheduleSyncClient(() => ({
      configured: true,
      mode: "cloud",
      apiBaseUrl: "https://cloud.example/api/v1",
      apiKey: "eliza_test",
      agentId: "agent/with space",
    }));

    await client.getMergedState("America/New_York", "effective");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.example/api/v1/eliza/agents/agent%2Fwith%20space/lifeops/schedule/merged-state?timezone=America%2FNew_York&scope=effective",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "X-API-Key": "eliza_test",
        }),
      })
    );
  });

  it("throws typed errors with parsed response messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json({ message: "schedule sync disabled" }, { status: 403 })
      )
    );

    const client = new LifeOpsScheduleSyncClient(() => ({
      configured: true,
      mode: "cloud",
      apiBaseUrl: "https://cloud.example/api/v1",
      apiKey: "eliza_test",
      agentId: "agent-1",
    }));

    await expect(client.getMergedState("UTC")).rejects.toBeInstanceOf(
      LifeOpsScheduleSyncClientError
    );
    await expect(client.getMergedState("UTC")).rejects.toMatchObject({
      status: 403,
      message: "schedule sync disabled",
    });
  });

  it("fails before fetch when sync is not configured", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const client = new LifeOpsScheduleSyncClient(() => ({
      configured: false,
      mode: "none",
    }));

    expect(client.configured).toBe(false);
    await expect(client.getMergedState("UTC")).rejects.toMatchObject({
      status: 409,
      message: "LifeOps schedule sync is not configured.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("LifeOps schedule sync config", () => {
  it("normalizes remote and cloud config values", () => {
    expect(normalizeLifeOpsScheduleSyncSecret(" [REDACTED] ")).toBeNull();
    expect(resolveLifeOpsScheduleSyncSiteUrl("https://cloud.example/app/")).toBe(
      "https://cloud.example/app"
    );

    expect(
      resolveLifeOpsScheduleSyncConfig({
        remoteApiBase: " https://agent.example/// ",
        remoteAccessToken: " remote-token ",
      })
    ).toMatchObject({
      configured: true,
      mode: "remote",
      baseUrl: "https://agent.example",
      accessToken: "remote-token",
    });

    expect(
      resolveLifeOpsScheduleSyncConfig({
        apiKey: " eliza_test ",
        baseUrl: "https://cloud.example",
        agentId: " agent-1 ",
      })
    ).toMatchObject({
      configured: true,
      mode: "cloud",
      apiKey: "eliza_test",
      agentId: "agent-1",
    });
  });
});
