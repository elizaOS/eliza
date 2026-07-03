// @vitest-environment jsdom

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capacitorMocks = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
  },
  CapacitorHttp: {
    request: capacitorMocks.request,
  },
}));

vi.mock("../bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: () => false,
}));

import { refreshCloudStewardSession } from "./client-cloud";

describe("refreshCloudStewardSession native bearer refresh", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    capacitorMocks.request.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("posts native refresh through CapacitorHttp with the stored Steward JWT as Bearer", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "stored-steward-jwt");
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    capacitorMocks.request.mockResolvedValue({
      status: 200,
      data: { ok: true, token: "fresh-steward-jwt", expiresIn: 3600 },
    });

    const result = await refreshCloudStewardSession({
      endpoint: "https://api.elizacloud.ai/api/auth/steward-refresh",
    });

    expect(capacitorMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.elizacloud.ai/api/auth/steward-refresh",
        method: "POST",
        headers: expect.objectContaining({
          Accept: "application/json",
          Authorization: "Bearer stored-steward-jwt",
        }),
      }),
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      token: "fresh-steward-jwt",
      expiresIn: 3600,
    });
  });

  it("does not require fetch for native bearer refresh", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "stored-steward-jwt");
    globalThis.fetch = undefined as unknown as typeof fetch;
    capacitorMocks.request.mockResolvedValue({
      status: 200,
      data: { token: "fresh-steward-jwt", expiresIn: 3600 },
    });

    await expect(
      refreshCloudStewardSession({
        endpoint: "https://api.elizacloud.ai/api/auth/steward-refresh",
      }),
    ).resolves.toEqual({
      token: "fresh-steward-jwt",
      expiresIn: 3600,
    });

    expect(capacitorMocks.request).toHaveBeenCalledTimes(1);
  });

  it("does not attempt a native refresh without a bearer token", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    await expect(
      refreshCloudStewardSession({
        endpoint: "https://api.elizacloud.ai/api/auth/steward-refresh",
      }),
    ).resolves.toBeNull();

    expect(capacitorMocks.request).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
