/** Verifies Telegram claim authority survives Steward login without replay or loss. */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingOnboardingSession,
  peekPendingOnboardingSession,
  storePendingOnboardingSession,
  TELEGRAM_ACCOUNT_CLAIM_PURPOSE,
} from "../../join/lib/onboarding-continuation";
import {
  exchangeStewardCodeViaApi,
  syncStewardSessionCookie,
} from "./steward-session";

const TOKEN = "telegram-claim-test-token-00000001";

afterEach(() => {
  clearPendingOnboardingSession();
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("Steward Telegram account claim handoff", () => {
  it("sends the pending claim on JWT sync and consumes it only after success", async () => {
    storePendingOnboardingSession(TOKEN, TELEGRAM_ACCOUNT_CLAIM_PURPOSE);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await syncStewardSessionCookie("steward-token", "refresh-token");

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      token: "steward-token",
      refreshToken: "refresh-token",
      telegramContinuation: TOKEN,
    });
    expect(peekPendingOnboardingSession()).toBeNull();
  });

  it("accepts explicit claim authority when the landing page is already authenticated", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await syncStewardSessionCookie("steward-token", undefined, {
      telegramContinuation: TOKEN,
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      token: "steward-token",
      telegramContinuation: TOKEN,
    });
  });

  it("rejects a guessable explicit claim before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncStewardSessionCookie("steward-token", undefined, {
        telegramContinuation: "platform:telegram:123456789",
      }),
    ).rejects.toThrow("Invalid Telegram account claim");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the claim for an idempotent retry when Cloud rejects the sync", async () => {
    storePendingOnboardingSession(TOKEN, TELEGRAM_ACCOUNT_CLAIM_PURPOSE);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "This Telegram chat cannot be linked automatically",
            code: "telegram_claim_conflict",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(syncStewardSessionCookie("steward-token")).rejects.toThrow(
      "This Telegram chat cannot be linked automatically",
    );
    expect(peekPendingOnboardingSession()).toBe(TOKEN);
  });

  it("carries the same claim through the OAuth nonce exchange", async () => {
    storePendingOnboardingSession(TOKEN, TELEGRAM_ACCOUNT_CLAIM_PURPOSE);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          userId: "cloud-user",
          stewardUserId: "steward-user",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await exchangeStewardCodeViaApi("one-time-code", {
      redirectUri: "https://cloud.eliza.app/login",
      tenantId: "elizacloud",
      codeVerifier: "verifier",
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      code: "one-time-code",
      redirectUri: "https://cloud.eliza.app/login",
      tenantId: "elizacloud",
      codeVerifier: "verifier",
      telegramContinuation: TOKEN,
    });
    expect(peekPendingOnboardingSession()).toBeNull();
  });

  it("leaves ordinary Discord and phone continuations on their confirm flow", async () => {
    storePendingOnboardingSession(TOKEN);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await syncStewardSessionCookie("steward-token");

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      token: "steward-token",
    });
    expect(peekPendingOnboardingSession()).toBe(TOKEN);
  });
});
