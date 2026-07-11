import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAccount, saveAccount } from "./account-storage";
import { refreshAnthropicToken } from "./anthropic";
import { getAccessToken, saveCredentials } from "./credentials";

// Only the refresh function is mocked; the rest of anthropic.ts is untouched so
// this test does not overlap #16090's anthropic OAuth changes.
vi.mock("./anthropic.ts", () => ({
  refreshAnthropicToken: vi.fn(),
}));

const tempHomes: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
function useTempElizaHome(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-auth-minrem-"));
  tempHomes.push(dir);
  for (const key of ["ELIZA_HOME", "HOME", "USERPROFILE"]) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    process.env[key] = dir;
  }
}

const MIN = 60 * 1000;

describe("getAccessToken minRemainingMs (proactive pre-spawn refresh)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      delete savedEnv[key];
    }
    for (const dir of tempHomes.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the existing token unchanged when omitted and TTL > default buffer", async () => {
    useTempElizaHome();
    const refreshMock = refreshAnthropicToken as unknown as ReturnType<
      typeof vi.fn
    >;
    saveCredentials(
      "anthropic-subscription",
      {
        access: "current-access",
        refresh: "current-refresh",
        // 30 min left: above the 5-min default buffer, below a 55-min run.
        expires: Date.now() + 30 * MIN,
      },
      "personal",
    );

    // Default behavior (no opts): 30 min > 5 min buffer → no refresh.
    await expect(
      getAccessToken("anthropic-subscription", "personal"),
    ).resolves.toBe("current-access");
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("forces a refresh when TTL is below minRemainingMs even though it exceeds the default buffer", async () => {
    useTempElizaHome();
    const refreshMock = refreshAnthropicToken as unknown as ReturnType<
      typeof vi.fn
    >;
    refreshMock.mockResolvedValue({
      access: "fresh-access",
      refresh: "fresh-refresh",
      expires: Date.now() + 60 * MIN,
    });
    saveCredentials(
      "anthropic-subscription",
      {
        access: "current-access",
        refresh: "current-refresh",
        expires: Date.now() + 30 * MIN, // 30 min left
      },
      "personal",
    );

    // Expected run 55 min > 30 min remaining → refresh.
    await expect(
      getAccessToken("anthropic-subscription", "personal", {
        minRemainingMs: 55 * MIN,
      }),
    ).resolves.toBe("fresh-access");
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(refreshMock).toHaveBeenCalledWith("current-refresh");
    expect(
      loadAccount("anthropic-subscription", "personal")?.credentials,
    ).toMatchObject({ access: "fresh-access", refresh: "fresh-refresh" });
  });

  it("reports insufficient lifetime when the refreshed token is still below minRemainingMs", async () => {
    useTempElizaHome();
    const refreshMock = refreshAnthropicToken as unknown as ReturnType<
      typeof vi.fn
    >;
    refreshMock.mockResolvedValue({
      access: "short-fresh-access",
      refresh: "short-fresh-refresh",
      expires: Date.now() + 30 * MIN,
    });
    saveCredentials(
      "anthropic-subscription",
      {
        access: "current-access",
        refresh: "current-refresh",
        expires: Date.now() + 10 * MIN,
      },
      "personal",
    );

    await expect(
      getAccessToken("anthropic-subscription", "personal", {
        minRemainingMs: 55 * MIN,
        outcome: true,
      }),
    ).resolves.toMatchObject({
      ok: false,
      kind: "insufficient-lifetime",
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(
      loadAccount("anthropic-subscription", "personal")?.credentials,
    ).toMatchObject({
      access: "short-fresh-access",
      refresh: "short-fresh-refresh",
    });
    await expect(
      getAccessToken("anthropic-subscription", "personal"),
    ).resolves.toBe("short-fresh-access");
  });

  it("serializes concurrent refreshes so a rotated token is reused by waiters", async () => {
    useTempElizaHome();
    const refreshMock = refreshAnthropicToken as unknown as ReturnType<
      typeof vi.fn
    >;
    let releaseRefresh!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      refreshMock.mockImplementationOnce(async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseRefresh = release;
        });
        return {
          access: "rotated-access",
          refresh: "rotated-refresh",
          expires: Date.now() + 90 * MIN,
        };
      });
    });
    saveCredentials(
      "anthropic-subscription",
      {
        access: "expired-access",
        refresh: "old-refresh",
        expires: Date.now() - MIN,
      },
      "personal",
    );

    const first = getAccessToken("anthropic-subscription", "personal", {
      minRemainingMs: 55 * MIN,
      outcome: true,
    });
    await refreshStarted;
    const second = getAccessToken("anthropic-subscription", "personal", {
      minRemainingMs: 55 * MIN,
      outcome: true,
    });
    releaseRefresh();

    await expect(first).resolves.toMatchObject({
      ok: true,
      accessToken: "rotated-access",
      refreshed: true,
    });
    await expect(second).resolves.toMatchObject({
      ok: true,
      accessToken: "rotated-access",
      refreshed: false,
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(refreshMock).toHaveBeenCalledWith("old-refresh");
    expect(
      loadAccount("anthropic-subscription", "personal")?.credentials.refresh,
    ).toBe("rotated-refresh");
  });

  it("best-effort fallback: a failed widened refresh returns null, but the default resolve still recovers the valid token", async () => {
    // Models the bridge's graceful degradation. A token with 30 min left is
    // inside a 55-min widened window, so getAccessToken forces a refresh; if
    // that refresh FAILS (transient outage), the widened call returns null.
    // The default-buffer call (no minRemainingMs) still returns the
    // still-valid token, so the bridge does not drop a usable account.
    useTempElizaHome();
    const refreshMock = refreshAnthropicToken as unknown as ReturnType<
      typeof vi.fn
    >;
    refreshMock.mockRejectedValue(new Error("transient anthropic 503"));
    saveCredentials(
      "anthropic-subscription",
      {
        access: "still-valid-access",
        refresh: "valid-refresh",
        expires: Date.now() + 30 * MIN, // valid, but inside the widened window
      },
      "personal",
    );

    // Widened resolve: refresh forced, refresh fails → null.
    await expect(
      getAccessToken("anthropic-subscription", "personal", {
        minRemainingMs: 55 * MIN,
      }),
    ).resolves.toBeNull();
    // Default resolve: 30 min > 5 min buffer → returns the still-valid token,
    // no refresh attempted. This is the recovery path the bridge takes.
    await expect(
      getAccessToken("anthropic-subscription", "personal"),
    ).resolves.toBe("still-valid-access");
  });

  it.each([
    "request deadline expired",
    "400 malformed refresh request",
  ])("does not classify a non-auth refresh failure as credential death: %s", async (message) => {
    useTempElizaHome();
    const refreshMock = refreshAnthropicToken as unknown as ReturnType<
      typeof vi.fn
    >;
    refreshMock.mockRejectedValue(new Error(message));
    saveCredentials(
      "anthropic-subscription",
      {
        access: "still-valid-access",
        refresh: "still-valid-refresh",
        expires: Date.now() + 10 * MIN,
      },
      "personal",
    );

    await expect(
      getAccessToken("anthropic-subscription", "personal", {
        minRemainingMs: 55 * MIN,
        outcome: true,
      }),
    ).resolves.toMatchObject({ ok: false, kind: "transient" });
  });

  it("does NOT refresh when TTL already exceeds minRemainingMs", async () => {
    useTempElizaHome();
    const refreshMock = refreshAnthropicToken as unknown as ReturnType<
      typeof vi.fn
    >;
    saveCredentials(
      "anthropic-subscription",
      {
        access: "long-lived-access",
        refresh: "long-lived-refresh",
        expires: Date.now() + 90 * MIN, // 90 min left
      },
      "personal",
    );

    await expect(
      getAccessToken("anthropic-subscription", "personal", {
        minRemainingMs: 55 * MIN,
      }),
    ).resolves.toBe("long-lived-access");
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("ignores a non-positive / NaN override (fail-safe: never disables refresh)", async () => {
    useTempElizaHome();
    const refreshMock = refreshAnthropicToken as unknown as ReturnType<
      typeof vi.fn
    >;
    // Token INSIDE the default 5-min buffer → default behavior must still refresh.
    refreshMock.mockResolvedValue({
      access: "fresh-access",
      refresh: "fresh-refresh",
      expires: Date.now() + 60 * MIN,
    });
    saveCredentials(
      "anthropic-subscription",
      {
        access: "near-expiry",
        refresh: "near-refresh",
        expires: Date.now() + 60 * 1000, // 1 min left, inside 5-min buffer
      },
      "personal",
    );

    for (const bad of [0, -5, Number.NaN]) {
      refreshMock.mockClear();
      saveAccount({
        id: "personal",
        providerId: "anthropic-subscription",
        label: "Default",
        source: "oauth",
        credentials: {
          access: "near-expiry",
          refresh: "near-refresh",
          expires: Date.now() + 60 * 1000,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      // A bad override collapses to the historical buffer, so a token inside
      // the 5-min window still refreshes (never left un-refreshed).
      await expect(
        getAccessToken("anthropic-subscription", "personal", {
          minRemainingMs: bad,
        }),
      ).resolves.toBe("fresh-access");
      expect(refreshMock).toHaveBeenCalledTimes(1);
    }
  });
});
