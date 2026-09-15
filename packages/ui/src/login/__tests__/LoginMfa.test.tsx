/** Exercises MFA rendering and step-up state through deterministic authentication context. */
import { LoginApiError } from "@elizaos/login";
import * as React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";

const { LoginMfaChallenge } = await import(
  "../components/LoginMfaChallenge.js"
);
const { LoginMfaSettings } = await import("../components/LoginMfaSettings.js");
const { useMfaStepUp } = await import("../hooks/useMfaStepUp.js");
const { LoginAuthContext } = await import("../provider.js");

type AuthCtx = React.ContextType<typeof LoginAuthContext>;

async function outsideMfaScenario(): Promise<never> {
  throw new Error("This authentication operation is outside the MFA scenario");
}

function authCtx(): NonNullable<AuthCtx> {
  return {
    isAuthenticated: true,
    isLoading: false,
    user: { id: "user-1", email: "u@example.com" },
    session: {
      token: "token",
      address: "0x1234",
      tenantId: "tenant-1",
      mfaVerifiedAt: 1_770_000_000_000,
      mfaMethod: "passkey",
      factorEnrollmentVerifiedAt: 1_770_000_000_111,
    },
    providers: null,
    isProvidersLoading: false,
    guestState: { isGuest: false, isExpired: false, expiryMessage: null },
    signInAsGuest: outsideMfaScenario,
    upgradeGuestWithEmail: outsideMfaScenario,
    deleteGuest: outsideMfaScenario,
    sendSmsOtp: outsideMfaScenario,
    verifySmsOtp: outsideMfaScenario,
    sendWhatsAppOtp: outsideMfaScenario,
    verifyWhatsAppOtp: outsideMfaScenario,
    signInWithTelegram: outsideMfaScenario,
    signInWithFarcaster: outsideMfaScenario,
    getIdentityToken: outsideMfaScenario,
    signOut: () => {},
    getToken: () => "token",
    signInWithPasskey: async () => ({
      token: "token",
      refreshToken: "refresh",
      expiresIn: 900,
      user: { id: "user-1", email: "u@example.com" },
    }),
    addPasskey: async () => ({
      token: "token",
      refreshToken: "refresh",
      expiresIn: 900,
      user: { id: "user-1", email: "u@example.com" },
    }),
    signInWithEmail: async () => ({
      ok: true,
      expiresAt: new Date().toISOString(),
    }),
    verifyEmailCallback: async () => ({
      token: "token",
      refreshToken: "refresh",
      expiresIn: 900,
      user: { id: "user-1", email: "u@example.com" },
    }),
    signInWithSIWE: async () => ({
      token: "token",
      refreshToken: "refresh",
      expiresIn: 900,
      user: { id: "user-1", email: "u@example.com" },
    }),
    signInWithSolana: async () => ({
      token: "token",
      refreshToken: "refresh",
      expiresIn: 900,
      user: { id: "user-1", email: "u@example.com" },
    }),
    signInWithOAuth: async () => ({
      token: "token",
      refreshToken: "refresh",
      expiresIn: 900,
      user: { id: "user-1", email: "u@example.com" },
    }),
    getTotpStatus: async () => ({ ok: true, enabled: false, pending: false }),
    enrollTotp: async () => ({
      ok: true,
      secret: "secret",
      otpauthUri: "otpauth://totp/x",
      expiresAt: new Date().toISOString(),
    }),
    verifyTotp: async () => ({
      ok: true,
      enabled: true,
      recoveryCodes: ["ABCDE-FGHJK"],
    }),
    completeTotpMfa: async () => ({
      token: "token",
      refreshToken: "refresh",
      expiresIn: 900,
      user: { id: "user-1", email: "u@example.com" },
    }),
    completeRecoveryCodeMfa: async () => ({
      token: "token",
      refreshToken: "refresh",
      expiresIn: 900,
      user: { id: "user-1", email: "u@example.com" },
    }),
    stepUpWithTotp: async () => ({
      token: "token",
      refreshToken: "refresh",
      expiresIn: 900,
      user: { id: "user-1", email: "u@example.com" },
    }),
    stepUpWithRecoveryCode: async () => ({
      token: "token",
      refreshToken: "refresh",
      expiresIn: 900,
      user: { id: "user-1", email: "u@example.com" },
    }),
    getRecoveryCodeStatus: async () => ({
      ok: true,
      enabled: false,
      remaining: 0,
    }),
    regenerateRecoveryCodes: async () => ({
      ok: true,
      recoveryCodes: ["ABCDE-FGHJK"],
    }),
    unenrollTotp: async () => ({ ok: true }),
    getSmsMfaStatus: async () => ({ ok: true, enabled: false, pending: false }),
    enrollSmsMfa: async () => ({
      ok: true,
      phone: "***0123",
      expiresAt: new Date().toISOString(),
    }),
    verifySmsMfa: async () => ({ ok: true, enabled: true, phone: "***0123" }),
    sendSmsMfaCode: async () => ({
      ok: true,
      phone: "***0123",
      expiresAt: new Date().toISOString(),
    }),
    completeSmsMfa: async () => ({
      token: "token",
      refreshToken: "refresh",
      expiresIn: 900,
      user: { id: "user-1", email: "u@example.com" },
    }),
    stepUpWithSms: async () => ({
      token: "token",
      refreshToken: "refresh",
      expiresIn: 900,
      user: { id: "user-1", email: "u@example.com" },
    }),
    completePasskeyMfa: async () => ({
      token: "token",
      refreshToken: "refresh",
      expiresIn: 900,
      user: { id: "user-1", email: "u@example.com" },
    }),
    unenrollSmsMfa: async () => ({ ok: true }),
    activeTenantId: "tenant-1",
    tenants: null,
    isTenantsLoading: false,
    listTenants: async () => [],
    switchTenant: async () => true,
    joinTenant: async () => ({
      tenantId: "tenant-1",
      tenantName: "Tenant",
      joinedAt: new Date().toISOString(),
      role: "owner",
    }),
    leaveTenant: async () => {},
  };
}

function wrap(node: React.ReactNode) {
  return React.createElement(
    LoginAuthContext.Provider,
    { value: authCtx() },
    node,
  );
}

describe("<LoginMfaChallenge />", () => {
  test("renders TOTP verification with recovery-code toggle", () => {
    const html = renderToString(
      wrap(
        React.createElement(LoginMfaChallenge, {
          challenge: {
            type: "totp",
            challengeId: "challenge-1",
            expiresAt: "2026-05-25T12:00:00.000Z",
          },
        }),
      ),
    );
    expect(html).toContain("multi-factor verification");
    expect(html).toContain("totp code");
    expect(html).toContain("use recovery code");
  });

  test("renders SMS verification without recovery-code toggle", () => {
    const html = renderToString(
      wrap(
        React.createElement(LoginMfaChallenge, {
          challenge: {
            type: "sms",
            challengeId: "challenge-2",
            expiresAt: "2026-05-25T12:00:00.000Z",
          },
        }),
      ),
    );
    expect(html).toContain("sms code");
    expect(html).not.toContain("use recovery code");
  });

  test("renders passkey verification as a WebAuthn button", () => {
    const html = renderToString(
      wrap(
        React.createElement(LoginMfaChallenge, {
          challenge: {
            type: "passkey",
            challengeId: "challenge-3",
            expiresAt: "2026-05-25T12:00:00.000Z",
          },
        }),
      ),
    );
    expect(html).toContain("verify with passkey");
    expect(html).not.toContain("recovery code");
    expect(html).not.toContain("one-time-code");
  });
});

describe("<LoginMfaSettings />", () => {
  test("renders MFA management sections", () => {
    const html = renderToString(
      wrap(React.createElement(LoginMfaSettings, {})),
    );
    expect(html).toContain("multi-factor authentication");
    expect(html).toContain("authenticator app");
    expect(html).toContain("sms");
    expect(html).toContain("recovery codes");
  });
});

describe("useMfaStepUp()", () => {
  test("exposes session MFA freshness and SDK MFA-error classifier", () => {
    function Probe() {
      const stepUp = useMfaStepUp();
      return React.createElement(
        "output",
        {},
        [
          stepUp.state.mfaVerifiedAt,
          stepUp.state.mfaMethod,
          stepUp.state.factorEnrollmentVerifiedAt,
          String(
            stepUp.isMfaRequiredError(
              new LoginApiError(
                "Wallet transaction signing requires a recent MFA step-up session",
                403,
              ),
            ),
          ),
          typeof stepUp.stepUpWithTotp,
          typeof stepUp.stepUpWithRecoveryCode,
          typeof stepUp.sendSmsCode,
          typeof stepUp.stepUpWithSms,
          typeof stepUp.stepUpWithPasskey,
        ].join("|"),
      );
    }

    const html = renderToString(wrap(React.createElement(Probe)));
    expect(html).toContain(
      "1770000000000|passkey|1770000000111|true|function|function|function|function|function",
    );
  });
});
