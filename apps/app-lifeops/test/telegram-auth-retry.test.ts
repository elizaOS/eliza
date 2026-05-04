import { describe, expect, test } from "vitest";
import { inferRetryableTelegramAuthState } from "../src/lifeops/telegram-auth.js";

describe("inferRetryableTelegramAuthState", () => {
  test("keeps active retry steps unchanged", () => {
    expect(
      inferRetryableTelegramAuthState({
        state: "waiting_for_code",
        error: null,
      }),
    ).toBe("waiting_for_code");
    expect(
      inferRetryableTelegramAuthState({
        state: "waiting_for_password",
        error: null,
      }),
    ).toBe("waiting_for_password");
  });

  test("maps invalid Telegram 2FA password errors back to waiting_for_password", () => {
    expect(
      inferRetryableTelegramAuthState({
        state: "error",
        error: "400: PASSWORD_HASH_INVALID (caused by auth.CheckPassword)",
      }),
    ).toBe("waiting_for_password");
  });

  test("maps invalid login code errors back to waiting_for_code", () => {
    expect(
      inferRetryableTelegramAuthState({
        state: "error",
        error: "PHONE_CODE_INVALID: Telegram login code is invalid",
      }),
    ).toBe("waiting_for_code");
  });

  test("maps provisioning code errors back to waiting_for_provisioning_code", () => {
    expect(
      inferRetryableTelegramAuthState({
        state: "error",
        error: "Invalid Telegram provisioning code",
      }),
    ).toBe("waiting_for_provisioning_code");
  });

  test("leaves unrelated error states unrecoverable", () => {
    expect(
      inferRetryableTelegramAuthState({
        state: "error",
        error: "Auth session not found or expired",
      }),
    ).toBeNull();
  });
});
