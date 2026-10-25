import { describe, expect, test } from "bun:test";
import {
  MOBILE_APP_AUTH_CLIENT_ID,
  MOBILE_APP_AUTH_CREDENTIAL_TTL_SECONDS,
  MOBILE_APP_AUTH_REDIRECT_URI,
  MobileAppAuthProtocolError,
  resolveMobileAppAuthRegistration,
} from "./mobile-app-auth";
import {
  MOBILE_CLIENT_MAX_CREDENTIAL_TTL_SECONDS,
  selectRegisteredMobileClient,
} from "./mobile-client-registry";

const PRIMARY_APP = "689a1597-85e7-43ca-b000-8c6392d79465";
const ALPHA_APP = "0b8f6a3e-2c4d-4e5f-9a1b-3c5d7e9f1a2b";
const ALPHA = {
  clientId: "ai.elizaresearch.alphaphone",
  appId: ALPHA_APP,
  redirectUri: "https://eliza.app/alphaphone/auth/callback",
  enabled: true,
};
const NINETY_DAYS = 90 * 24 * 60 * 60;
const reserved = {
  clientId: MOBILE_APP_AUTH_CLIENT_ID,
  appId: PRIMARY_APP,
  redirectUri: MOBILE_APP_AUTH_REDIRECT_URI,
};
const env = (clients: unknown[]) => ({
  ENVIRONMENT: "production",
  ELIZA_MOBILE_APP_AUTH_ENABLED: "true",
  ELIZA_MOBILE_APP_AUTH_APP_ID: PRIMARY_APP,
  ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON: JSON.stringify(clients),
});

describe("mobile client registry credential lifetime", () => {
  test("a registered client may request 90-day credentials", () => {
    const registration = resolveMobileAppAuthRegistration(
      env([{ ...ALPHA, credentialTtlSeconds: NINETY_DAYS }]),
      ALPHA.clientId,
    );
    expect(registration).toEqual({
      clientId: ALPHA.clientId,
      appId: ALPHA_APP,
      redirectUri: ALPHA.redirectUri,
      enabled: true,
      environment: "production",
      scopes: ["cloud:user"],
      credentialTtlSeconds: NINETY_DAYS,
    } as never);
    expect(MOBILE_CLIENT_MAX_CREDENTIAL_TTL_SECONDS).toBe(NINETY_DAYS);
  });

  test("clients without an explicit lifetime keep the 30-day default", () => {
    expect(
      resolveMobileAppAuthRegistration(env([ALPHA]), ALPHA.clientId).credentialTtlSeconds,
    ).toBe(MOBILE_APP_AUTH_CREDENTIAL_TTL_SECONDS);
    expect(MOBILE_APP_AUTH_CREDENTIAL_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
    expect(resolveMobileAppAuthRegistration(env([ALPHA])).credentialTtlSeconds).toBe(
      MOBILE_APP_AUTH_CREDENTIAL_TTL_SECONDS,
    );
  });

  test.each([
    ["above 90 days", NINETY_DAYS + 1],
    ["below one day", 3_600],
    ["fractional", 86_400.5],
    ["a string", "7776000"],
    ["null", null],
    ["zero", 0],
    ["negative", -1],
  ])("rejects a lifetime that is %s and fails the whole registry closed", (_name, value) => {
    expect(
      selectRegisteredMobileClient(
        JSON.stringify([{ ...ALPHA, credentialTtlSeconds: value }]),
        ALPHA.clientId,
        reserved,
      ),
    ).toEqual({ ok: false, code: "server_configuration_error" });
  });

  test("keeps rejecting unknown keys", () => {
    expect(
      selectRegisteredMobileClient(
        JSON.stringify([{ ...ALPHA, scopes: ["admin"] }]),
        ALPHA.clientId,
        reserved,
      ),
    ).toEqual({ ok: false, code: "server_configuration_error" });
  });

  test("a disabled or unknown client is invalid_client, never the default", () => {
    expect(() =>
      resolveMobileAppAuthRegistration(env([{ ...ALPHA, enabled: false }]), ALPHA.clientId),
    ).toThrow(MobileAppAuthProtocolError);
    expect(
      selectRegisteredMobileClient(JSON.stringify([ALPHA]), "ai.example.other", reserved),
    ).toEqual({ ok: false, code: "invalid_client" });
  });

  test("Alpha cannot reuse the primary client's app id or redirect", () => {
    for (const clash of [
      { appId: PRIMARY_APP },
      { redirectUri: MOBILE_APP_AUTH_REDIRECT_URI },
      { clientId: MOBILE_APP_AUTH_CLIENT_ID },
    ]) {
      expect(
        selectRegisteredMobileClient(
          JSON.stringify([{ ...ALPHA, ...clash }]),
          ALPHA.clientId,
          reserved,
        ),
      ).toEqual({ ok: false, code: "server_configuration_error" });
    }
  });
});
