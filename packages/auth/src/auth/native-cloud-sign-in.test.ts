import { describe, expect, it } from "vitest";
import {
  NATIVE_CLOUD_SIGN_IN_FAILURE_CODES,
  NativeCloudSignInError,
  nativeCloudSignInFailureMessage,
  nativeSignInAuthenticated,
  nativeSignInCodeStarted,
  nativeSignInGoogleOutcome,
  nativeSignInReadiness,
  nativeSignInVerified,
  normalizeNativeSignInCode,
  validNativeSignInEmail,
  validNativeSignInPhone,
} from "./native-cloud-sign-in.ts";

const ATTEMPT = "6f1c2b0e-8d47-4c55-9e43-0f3c1a2b4d5e";
const NOW = 1_800_000_000_000;
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof NativeCloudSignInError ? error.code : "other";
  }
  return undefined;
};

describe("native Cloud sign-in renderer contract", () => {
  it("accepts a completed sign-in only for the requested deployment and documented fields", () => {
    expect(
      nativeSignInAuthenticated(
        {
          status: "authenticated",
          environment: "production",
          expiresAt: NOW,
          accountCreated: true,
          previousSignIn: "revoked",
        },
        "production",
      ),
    ).toEqual({
      status: "authenticated",
      environment: "production",
      expiresAt: NOW,
      accountCreated: true,
      previousSignIn: "revoked",
    });
    const plain = nativeSignInAuthenticated(
      {
        status: "authenticated",
        environment: "staging",
        expiresAt: new Date(NOW).toISOString(),
      },
      "staging",
    );
    expect(plain.accountCreated).toBeNull();
    expect("previousSignIn" in plain).toBe(false);
    for (const bad of [
      {
        status: "authenticated",
        environment: "staging",
        expiresAt: NOW,
      },
      {
        status: "authenticated",
        environment: "production",
        expiresAt: NOW,
        token: "secret",
      },
      {
        status: "authenticated",
        environment: "production",
        expiresAt: NOW,
        previousSignIn: "lost",
      },
      { status: "authenticated", environment: "production", expiresAt: -1 },
      null,
      [],
    ])
      expect(code(() => nativeSignInAuthenticated(bad, "production"))).toBe(
        "unavailable",
      );
  });

  it("reads a started code attempt and refuses malformed attempt ids or times", () => {
    expect(
      nativeSignInCodeStarted({
        attemptId: ATTEMPT,
        expiresAt: NOW + 600_000,
        resendAt: NOW + 60_000,
      }),
    ).toEqual({
      attemptId: ATTEMPT,
      expiresAt: NOW + 600_000,
      resendAt: NOW + 60_000,
    });
    expect(
      code(() =>
        nativeSignInCodeStarted({
          attemptId: "short",
          expiresAt: NOW,
          resendAt: NOW,
        }),
      ),
    ).toBe("unavailable");
    expect(
      code(() =>
        nativeSignInCodeStarted({
          attemptId: ATTEMPT,
          expiresAt: "never",
          resendAt: NOW,
        }),
      ),
    ).toBe("unavailable");
  });

  it("distinguishes a second factor from a sign-in and checks its method", () => {
    expect(
      nativeSignInVerified(
        { status: "mfa", method: "totp", expiresAt: NOW, attemptId: ATTEMPT },
        "production",
      ),
    ).toEqual({
      status: "mfa",
      method: "totp",
      expiresAt: NOW,
      attemptId: ATTEMPT,
    });
    expect(
      code(() =>
        nativeSignInVerified(
          { status: "mfa", method: "email", expiresAt: NOW },
          "production",
        ),
      ),
    ).toBe("unavailable");
    expect(
      nativeSignInVerified(
        { status: "authenticated", environment: "production", expiresAt: NOW },
        "production",
      ).status,
    ).toBe("authenticated");
  });

  it("binds a Google second factor to its attempt and deployment and refuses a lapsed one", () => {
    const mfa = {
      status: "mfa",
      method: "sms",
      expiresAt: NOW + 60_000,
      attemptId: ATTEMPT,
      environment: "production",
    };
    expect(nativeSignInGoogleOutcome(mfa, "production", NOW)).toEqual(mfa);
    expect(code(() => nativeSignInGoogleOutcome(mfa, "staging", NOW))).toBe(
      "unavailable",
    );
    expect(
      code(() =>
        nativeSignInGoogleOutcome({ ...mfa, extra: 1 }, "production", NOW),
      ),
    ).toBe("unavailable");
    expect(
      code(() =>
        nativeSignInGoogleOutcome(
          { ...mfa, attemptId: undefined },
          "production",
          NOW,
        ),
      ),
    ).toBe("unavailable");
    expect(
      code(() => nativeSignInGoogleOutcome(mfa, "production", NOW + 60_000)),
    ).toBe("expired");
  });

  it("keeps a native rejection code only when the client defines it", () => {
    expect(NativeCloudSignInError.from({ code: "cooldown" }).code).toBe(
      "cooldown",
    );
    expect(NativeCloudSignInError.from({ code: "http-expired" }).code).toBe(
      "unavailable",
    );
    expect(NativeCloudSignInError.from(new Error("boom")).code).toBe(
      "unavailable",
    );
    const same = new NativeCloudSignInError("storage");
    expect(NativeCloudSignInError.from(same)).toBe(same);
  });

  it("names the product and deployment in copy and never echoes server text", () => {
    const copy = { serviceName: "Example Cloud", productName: "Example" };
    for (const failure of NATIVE_CLOUD_SIGN_IN_FAILURE_CODES) {
      const text = nativeCloudSignInFailureMessage(failure, copy);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/Eliza|Alpha/);
    }
    expect(nativeCloudSignInFailureMessage("offline", copy)).toBe(
      "Example could not reach Example Cloud. Check your connection and try again.",
    );
  });

  it("reads explicit readiness only and never infers SMS", () => {
    expect(
      nativeSignInReadiness({ inApp: true, google: true, email: true }),
    ).toEqual({
      google: true,
      phone: false,
      email: true,
    });
    expect(nativeSignInReadiness({ methodsKnown: true, phone: true })).toEqual({
      google: false,
      phone: true,
      email: false,
    });
    expect(nativeSignInReadiness({ google: true })).toBeNull();
    expect(nativeSignInReadiness(null)).toBeNull();
  });

  it("normalizes codes and validates email and phone input", () => {
    expect(normalizeNativeSignInCode("123 456")).toBe("123456");
    expect(normalizeNativeSignInCode("123-45")).toBeNull();
    expect(validNativeSignInEmail(" owner@example.invalid ")).toBe(true);
    expect(validNativeSignInEmail("owner@example")).toBe(false);
    expect(validNativeSignInPhone("+14155550100")).toBe(true);
    expect(validNativeSignInPhone("4155550100")).toBe(false);
  });
});
