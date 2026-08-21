/** Verifies Telegram claim authority survives Steward login without replay or loss. */
// @vitest-environment jsdom

import { StewardSessionError } from "@elizaos/shared/steward-session-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingOnboardingSession,
  peekPendingOnboardingSession,
  storePendingOnboardingSession,
  TELEGRAM_ACCOUNT_CLAIM_PURPOSE,
} from "../../join/lib/onboarding-continuation";
import {
  confirmTelegramAccountClaim,
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
  it("establishes a JWT session without sending or consuming a pending claim", async () => {
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
    });
    expect(peekPendingOnboardingSession(TELEGRAM_ACCOUNT_CLAIM_PURPOSE)).toBe(
      TOKEN,
    );
  });

  it("accepts explicit claim authority when the landing page is already authenticated", async () => {
    storePendingOnboardingSession(TOKEN, TELEGRAM_ACCOUNT_CLAIM_PURPOSE);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await confirmTelegramAccountClaim("steward-token", TOKEN);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      token: "steward-token",
      telegramContinuation: TOKEN,
      telegramClaimConfirmation: "explicit",
    });
    expect(peekPendingOnboardingSession()).toBeNull();
  });

  it("rejects a guessable explicit claim before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      confirmTelegramAccountClaim(
        "steward-token",
        "platform:telegram:123456789",
      ),
    ).rejects.toThrow("Invalid Telegram account claim");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not require callers to opt out of claim consumption", async () => {
    storePendingOnboardingSession(TOKEN, TELEGRAM_ACCOUNT_CLAIM_PURPOSE);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await syncStewardSessionCookie("steward-token", null);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      token: "steward-token",
    });
    expect(peekPendingOnboardingSession(TELEGRAM_ACCOUNT_CLAIM_PURPOSE)).toBe(
      TOKEN,
    );
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

    const failure = await confirmTelegramAccountClaim(
      "steward-token",
      TOKEN,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StewardSessionError);
    expect(failure).toMatchObject({
      status: 409,
      code: "telegram_claim_conflict",
      message: "This Telegram chat cannot be linked automatically",
    });
    expect(peekPendingOnboardingSession()).toBe(TOKEN);
  });

  it("does not clear a newer claim when an older explicit claim succeeds", async () => {
    const newerToken = "telegram-claim-test-token-00000002";
    storePendingOnboardingSession(newerToken, TELEGRAM_ACCOUNT_CLAIM_PURPOSE);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await confirmTelegramAccountClaim("steward-token", TOKEN);

    expect(peekPendingOnboardingSession(TELEGRAM_ACCOUNT_CLAIM_PURPOSE)).toBe(
      newerToken,
    );
  });

  it("exchanges an OAuth nonce without sending or consuming the claim", async () => {
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
    });
    expect(peekPendingOnboardingSession(TELEGRAM_ACCOUNT_CLAIM_PURPOSE)).toBe(
      TOKEN,
    );
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
