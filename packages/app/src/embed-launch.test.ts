import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapEmbedLaunch } from "./embed-launch";

function locationFor(path: string): Location {
  return new URL(`https://app.eliza.example${path}`) as unknown as Location;
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function fetchMock(response: Response): typeof fetch {
  return vi.fn(async () => response) as unknown as typeof fetch;
}

describe("bootstrapEmbedLaunch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete (window as Window & { Telegram?: unknown }).Telegram;
  });

  it("skips non-/embed paths", async () => {
    const fetch = fetchMock(okJson({ token: "tok" }));
    const result = await bootstrapEmbedLaunch({
      fetch,
      location: locationFor("/"),
      applyToken: vi.fn(),
    });
    expect(result.status).toBe("skipped");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("authenticates Telegram initData and stores the returned token", async () => {
    const ready = vi.fn();
    (window as Window & { Telegram?: unknown }).Telegram = {
      WebApp: { initData: "tg-init-data", ready },
    };
    const applyToken = vi.fn();
    const markReady = vi.fn();
    const fetch = fetchMock(okJson({ token: "embed-token", expiresAt: 123 }));

    const result = await bootstrapEmbedLaunch({
      fetch,
      location: locationFor("/embed?platform=telegram"),
      applyToken,
      markReady,
    });

    expect(result).toEqual({ status: "authenticated", platform: "telegram" });
    expect(fetch).toHaveBeenCalledWith(
      "/api/embed/auth",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: "telegram",
          signedLaunchPayload: "tg-init-data",
        }),
      }),
    );
    expect(applyToken).toHaveBeenCalledWith("embed-token");
    expect(markReady).toHaveBeenCalledWith("telegram");
    expect(ready).toHaveBeenCalled();
  });

  it("authenticates a Discord OAuth code and removes it from the URL", async () => {
    const applyToken = vi.fn();
    const replaceState = vi.fn();
    const fetch = fetchMock(okJson({ token: "discord-token" }));

    const result = await bootstrapEmbedLaunch({
      fetch,
      location: locationFor("/embed?platform=discord&code=oauth-code"),
      history: { replaceState },
      applyToken,
    });

    expect(result).toEqual({ status: "authenticated", platform: "discord" });
    expect(fetch).toHaveBeenCalledWith(
      "/api/embed/auth",
      expect.objectContaining({
        body: JSON.stringify({
          platform: "discord",
          signedLaunchPayload: "oauth-code",
        }),
      }),
    );
    expect(applyToken).toHaveBeenCalledWith("discord-token");
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/embed?platform=discord",
    );
  });

  it("fails closed when the launch payload is missing", async () => {
    const fetch = fetchMock(okJson({ token: "tok" }));
    const result = await bootstrapEmbedLaunch({
      fetch,
      location: locationFor("/embed?platform=discord"),
      applyToken: vi.fn(),
    });
    expect(result).toEqual({ status: "missing-payload", platform: "discord" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not store a token when auth rejects", async () => {
    const applyToken = vi.fn();
    const fetch = fetchMock(new Response("forbidden", { status: 403 }));
    const result = await bootstrapEmbedLaunch({
      fetch,
      location: locationFor(
        "/embed?platform=telegram&signedLaunchPayload=forged",
      ),
      applyToken,
    });
    expect(result).toEqual({
      status: "auth-failed",
      platform: "telegram",
      statusCode: 403,
    });
    expect(applyToken).not.toHaveBeenCalled();
  });

  it("does not store a token when the route returns no token", async () => {
    const applyToken = vi.fn();
    const fetch = fetchMock(okJson({ token: null }));
    const result = await bootstrapEmbedLaunch({
      fetch,
      location: locationFor(
        "/embed?platform=telegram&signedLaunchPayload=valid",
      ),
      applyToken,
    });
    expect(result).toEqual({ status: "no-token", platform: "telegram" });
    expect(applyToken).not.toHaveBeenCalled();
  });
});
