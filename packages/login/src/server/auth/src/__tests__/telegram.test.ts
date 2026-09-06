import { describe, expect, it } from "bun:test";
import {
  signTelegramLoginPayload,
  telegramLoginDataCheckString,
  verifyTelegramLogin,
} from "../telegram";

const BOT_TOKEN = "123456:telegram-test-token";
const AUTH_DATE = 1_700_000_000;

function signedPayload(overrides: Record<string, unknown> = {}) {
  const payload = {
    id: "424242",
    first_name: "Ada",
    last_name: "Lovelace",
    username: "ada",
    photo_url: "https://t.me/i/userpic/320/ada.jpg",
    auth_date: AUTH_DATE,
    ...overrides,
  };
  return { ...payload, hash: signTelegramLoginPayload(payload, BOT_TOKEN) };
}

describe("Telegram login verifier", () => {
  it("builds the official sorted data-check string without the hash", () => {
    expect(
      telegramLoginDataCheckString({
        username: "ada",
        hash: "ignored",
        id: "424242",
        auth_date: AUTH_DATE,
      }),
    ).toBe(`auth_date=${AUTH_DATE}\nid=424242\nusername=ada`);
  });

  it("verifies a valid signed login widget payload", () => {
    const verified = verifyTelegramLogin(signedPayload(), BOT_TOKEN, {
      nowMs: (AUTH_DATE + 60) * 1000,
    });

    expect(verified).toEqual({
      id: "424242",
      firstName: "Ada",
      lastName: "Lovelace",
      username: "ada",
      photoUrl: "https://t.me/i/userpic/320/ada.jpg",
      authDate: AUTH_DATE,
    });
  });

  it("rejects tampering, missing hashes, and stale auth_date values", () => {
    expect(() =>
      verifyTelegramLogin(
        { ...signedPayload(), username: "mallory" },
        BOT_TOKEN,
        {
          nowMs: (AUTH_DATE + 60) * 1000,
        },
      ),
    ).toThrow("hash mismatch");

    const { hash: _hash, ...withoutHash } = signedPayload();
    expect(() => verifyTelegramLogin(withoutHash, BOT_TOKEN)).toThrow(
      "hash is required",
    );

    expect(() =>
      verifyTelegramLogin(signedPayload(), BOT_TOKEN, {
        nowMs: (AUTH_DATE + 24 * 60 * 60 + 1) * 1000,
      }),
    ).toThrow("expired");
  });

  it("rejects auth_date values too far in the future", () => {
    expect(() =>
      verifyTelegramLogin(
        signedPayload({ auth_date: AUTH_DATE + 600 }),
        BOT_TOKEN,
        {
          nowMs: AUTH_DATE * 1000,
        },
      ),
    ).toThrow("future");
  });
});
