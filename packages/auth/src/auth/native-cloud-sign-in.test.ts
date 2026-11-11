import { describe, expect, it } from "vitest";
import {
  NATIVE_CLOUD_SIGN_IN_FAILURE_CODES,
  NativeCloudSignInError,
  nativeCloudSignInFailureMessage,
  nativeSignInActivationPending,
  nativeSignInAuthenticated,
  nativeSignInCodeStarted,
  nativeSignInGoogleOutcome,
  nativeSignInReadiness,
  nativeSignInReadinessChanged,
  nativeSignInRenewal,
  nativeSignInRenewed,
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
    // A second factor for another deployment, or with undocumented fields, is not trusted.
    expect(
      nativeSignInVerified(
        {
          status: "mfa",
          method: "sms",
          expiresAt: NOW,
          attemptId: ATTEMPT,
          environment: "production",
        },
        "production",
      ).status,
    ).toBe("mfa");
    expect(
      code(() =>
        nativeSignInVerified(
          {
            status: "mfa",
            method: "totp",
            expiresAt: NOW,
            environment: "staging",
          },
          "production",
        ),
      ),
    ).toBe("unavailable");
    expect(
      code(() =>
        nativeSignInVerified(
          { status: "mfa", method: "totp", expiresAt: NOW, challengeId: "x" },
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

  it("keeps a rejection's kept-step marker and drops every other datum", () => {
    // Capacitor rejections carry `data` beside `code`; a kept code step says so there.
    for (const kept of [
      "invalid-code",
      "offline",
      "unavailable",
      "rate-limited",
    ]) {
      const error = NativeCloudSignInError.from({
        code: kept,
        message: kept,
        data: { attemptKept: true, token: "never-kept", status: 503 },
      });
      expect(error.code).toBe(kept);
      expect(error.attemptKept).toBe(true);
      expect(error.data).toEqual({ attemptKept: true });
    }
    // Anything but an explicit `true` is not a kept step.
    for (const data of [
      undefined,
      null,
      {},
      { attemptKept: false },
      { attemptKept: "true" },
      { attemptKept: 1 },
      [true],
      "attemptKept",
    ]) {
      const error = NativeCloudSignInError.from({ code: "invalid-code", data });
      expect(error.attemptKept).toBe(false);
      expect(error.data).toEqual({});
    }
    // The marker survives a code this client does not define: the step is still open natively.
    const unknown = NativeCloudSignInError.from({
      code: "http-expired",
      data: { attemptKept: true },
    });
    expect(unknown.code).toBe("unavailable");
    expect(unknown.attemptKept).toBe(true);
    expect(new NativeCloudSignInError("expired").attemptKept).toBe(false);
    const built = new NativeCloudSignInError("offline", { attemptKept: true });
    expect(NativeCloudSignInError.from(built)).toBe(built);
    expect(built.attemptKept).toBe(true);
  });

  it("defines a key Cloud never confirmed as its own failure", () => {
    expect(NATIVE_CLOUD_SIGN_IN_FAILURE_CODES.has("activation-expired")).toBe(
      true,
    );
    expect(
      NativeCloudSignInError.from({ code: "activation-expired" }).code,
    ).toBe("activation-expired");
    const copy = { serviceName: "Example Cloud", productName: "Example" };
    const expired = nativeCloudSignInFailureMessage("activation-expired", copy);
    expect(expired).toBe(
      "Example Cloud did not confirm this sign-in in time, so you are not signed in. Sign in again.",
    );
    // Not the pending copy: nothing is retried for an expired activation.
    expect(expired).not.toBe(
      nativeCloudSignInFailureMessage("activation-pending", copy),
    );
    expect(expired).not.toBe(
      nativeCloudSignInFailureMessage("unavailable", copy),
    );
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

  it("reads a saved key that still awaits Cloud's confirmation from status", () => {
    expect(
      nativeSignInActivationPending({
        active: false,
        activationPending: true,
        methodsKnown: true,
        inApp: true,
        email: true,
        phone: false,
        google: false,
      }),
    ).toBe(true);
    for (const value of [
      { active: false, methodsKnown: true },
      { activationPending: false },
      { activationPending: "true" },
      null,
      [],
      "activationPending",
    ])
      expect(nativeSignInActivationPending(value)).toBe(false);
  });

  it("reads a readiness change only for this deployment and only from explicit booleans", () => {
    const event = {
      environment: "production",
      active: false,
      methodsKnown: true,
      inApp: true,
      email: true,
      phone: false,
      google: true,
    };
    expect(nativeSignInReadinessChanged(event, "production")).toEqual({
      environment: "production",
      readiness: { google: true, phone: false, email: true },
      activationPending: false,
    });
    expect(
      nativeSignInReadinessChanged(
        { ...event, active: true, kind: "email", activationPending: true },
        "production",
      ),
    ).toEqual({
      environment: "production",
      readiness: { google: true, phone: false, email: true },
      activationPending: true,
    });
    // Cloud no longer answers: the methods are unknown again, not "none".
    expect(
      nativeSignInReadinessChanged(
        {
          environment: "production",
          methodsKnown: false,
          inApp: false,
          email: false,
          phone: false,
          google: false,
        },
        "production",
      ),
    ).toEqual({
      environment: "production",
      readiness: null,
      activationPending: false,
    });
    for (const bad of [
      { ...event, environment: "staging" },
      { ...event, environment: undefined },
      { ...event, google: "true" },
      { ...event, phone: undefined },
      { ...event, methodsKnown: 1 },
      null,
      [event],
      "production",
    ])
      expect(nativeSignInReadinessChanged(bad, "production")).toBeNull();
  });

  it("reads where silent renewal stands and when the expiry warning applies", () => {
    const CREDENTIAL = "0b6f3c1e-5a52-4c0e-9d5e-1f2a3b4c5d6e";
    expect(
      nativeSignInRenewal(
        {
          environment: "production",
          status: "renewed",
          expiryWarning: false,
          expiresAt: NOW,
          credentialId: CREDENTIAL,
        },
        "production",
      ),
    ).toEqual({
      environment: "production",
      status: "renewed",
      expiryWarning: false,
      expiresAt: NOW,
      credentialId: CREDENTIAL,
    });
    for (const status of [
      "current",
      "deferred",
      "sign-in-required",
      "unavailable",
    ] as const)
      expect(
        nativeSignInRenewal(
          {
            environment: "production",
            status,
            expiryWarning: status !== "current",
            expiresAt: new Date(NOW).toISOString(),
          },
          "production",
        ),
      ).toEqual({
        environment: "production",
        status,
        expiryWarning: status !== "current",
        expiresAt: NOW,
      });
    const signedOut = nativeSignInRenewal(
      { environment: "staging", status: "signed-out", expiryWarning: false },
      "staging",
    );
    expect(signedOut).toEqual({
      environment: "staging",
      status: "signed-out",
      expiryWarning: false,
    });
    expect("expiresAt" in signedOut).toBe(false);
    const base = {
      environment: "production",
      status: "deferred",
      expiryWarning: true,
      expiresAt: NOW,
    };
    for (const bad of [
      { ...base, environment: "staging" },
      { ...base, status: "expired" },
      { ...base, status: undefined },
      { ...base, expiryWarning: "true" },
      { ...base, expiryWarning: undefined },
      { ...base, expiresAt: "soon" },
      { ...base, token: "eliza_mobile_never" },
      // Only a renewal installs a credential.
      { ...base, credentialId: CREDENTIAL },
      { ...base, status: "renewed", expiryWarning: false },
      {
        ...base,
        status: "renewed",
        expiryWarning: false,
        credentialId: "not-an-id",
      },
      {
        environment: "production",
        status: "renewed",
        expiryWarning: false,
        credentialId: CREDENTIAL,
      },
      // A renewed key is never about to expire.
      { ...base, status: "renewed", credentialId: CREDENTIAL },
      null,
      [],
    ])
      expect(code(() => nativeSignInRenewal(bad, "production"))).toBe(
        "unavailable",
      );
  });

  it("reads a silent renewal announcement for exactly this deployment", () => {
    const CREDENTIAL = "0b6f3c1e-5a52-4c0e-9d5e-1f2a3b4c5d6e";
    const event = {
      environment: "production",
      expiresAt: NOW,
      credentialId: CREDENTIAL,
    };
    expect(nativeSignInRenewed(event, "production")).toEqual(event);
    for (const bad of [
      { ...event, environment: "staging" },
      { ...event, credentialId: "not-an-id" },
      { ...event, credentialId: undefined },
      { ...event, expiresAt: 0 },
      { ...event, token: "eliza_mobile_never" },
      null,
    ])
      expect(code(() => nativeSignInRenewed(bad, "production"))).toBe(
        "unavailable",
      );
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

describe("native completion correlation metadata", () => {
  const completion = {
    status: "authenticated",
    environment: "production",
    expiresAt: NOW,
    attemptId: ATTEMPT,
    credentialId: ATTEMPT,
    requestId: ATTEMPT,
  };
  it("retains validated request, native attempt and installed credential identities", () => {
    expect(nativeSignInAuthenticated(completion, "production")).toMatchObject(
      completion,
    );
    expect(
      nativeSignInGoogleOutcome(
        {
          status: "mfa",
          environment: "production",
          attemptId: ATTEMPT,
          requestId: ATTEMPT,
          method: "totp",
          expiresAt: NOW,
        },
        "production",
        NOW - 1,
      ),
    ).toMatchObject({ requestId: ATTEMPT });
  });
  it.each([
    { ...completion, credentialId: undefined },
    { ...completion, requestId: "invalid" },
    { ...completion, attemptId: "invalid" },
    { ...completion, credentialId: "secret" },
  ])("refuses malformed or partial completion identities", (bad) => {
    expect(code(() => nativeSignInAuthenticated(bad, "production"))).toBe(
      "unavailable",
    );
  });
});
