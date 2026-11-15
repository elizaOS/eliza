import { describe, expect, test } from "bun:test";
import {
  MOBILE_APP_AUTH_CLIENT_ID,
  MOBILE_APP_AUTH_CREDENTIAL_TTL_SECONDS,
  MOBILE_APP_AUTH_REDIRECT_URI,
} from "./mobile-app-auth";
import {
  MOBILE_CLIENT_MAX_CREDENTIAL_TTL_SECONDS,
  selectRegisteredMobileClient,
} from "./mobile-client-registry";

const PRIMARY_APP = "689a1597-85e7-43ca-b000-8c6392d79465";
const ALPHA_APP = "0b8f6a3e-2c4d-4e5f-9a1b-3c5d7e9f1a2b";
const ALPHA = {
  clientId: "org.example.reader",
  appId: ALPHA_APP,
  redirectUri: "https://eliza.app/reader/auth/callback",
  enabled: true,
};
const NINETY_DAYS = 90 * 24 * 60 * 60;
const reserved = {
  clientId: MOBILE_APP_AUTH_CLIENT_ID,
  appId: PRIMARY_APP,
  redirectUri: MOBILE_APP_AUTH_REDIRECT_URI,
};

describe("mobile client registry credential lifetime", () => {
  test("a registered client may request 90-day credentials", () => {
    const selected = selectRegisteredMobileClient(
      JSON.stringify([{ ...ALPHA, credentialTtlSeconds: NINETY_DAYS }]),
      ALPHA.clientId,
      reserved,
    );
    expect(selected).toEqual({
      ok: true,
      registration: {
        clientId: ALPHA.clientId,
        appId: ALPHA_APP,
        redirectUri: ALPHA.redirectUri,
        enabled: true,
        credentialTtlSeconds: NINETY_DAYS,
      },
    });
    expect(MOBILE_CLIENT_MAX_CREDENTIAL_TTL_SECONDS).toBe(NINETY_DAYS);
  });

  test("clients without an explicit lifetime keep credentialTtlSeconds undefined (defaults to 30 days)", () => {
    const selected = selectRegisteredMobileClient(
      JSON.stringify([ALPHA]),
      ALPHA.clientId,
      reserved,
    );
    expect(selected.ok).toBe(true);
    if (selected.ok) {
      expect(selected.registration.credentialTtlSeconds).toBeUndefined();
    }
    expect(MOBILE_APP_AUTH_CREDENTIAL_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
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
    expect(
      selectRegisteredMobileClient(
        JSON.stringify([{ ...ALPHA, enabled: false }]),
        ALPHA.clientId,
        reserved,
      ),
    ).toEqual({ ok: false, code: "invalid_client" });
    expect(
      selectRegisteredMobileClient(JSON.stringify([ALPHA]), "ai.example.other", reserved),
    ).toEqual({ ok: false, code: "invalid_client" });
  });

  test("An additional client cannot reuse the primary client's app id or redirect", () => {
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

test("an installed compatibility client resolves its own name with the same owner binding and scope", () => {
  const alias = { ...ALPHA, clientId: "org.example.legacy", aliasOf: ALPHA.clientId };
  const selected = selectRegisteredMobileClient(
    JSON.stringify([ALPHA, alias]),
    alias.clientId,
    reserved,
  );
  expect(selected.ok).toBe(true);
  if (selected.ok) {
    expect(selected.registration.clientId).toBe(alias.clientId);
    expect(selected.registration.appId).toBe(ALPHA.appId);
    expect(selected.registration.redirectUri).toBe(ALPHA.redirectUri);
  }
  expect(
    selectRegisteredMobileClient(
      JSON.stringify([{ ...ALPHA, enabled: false }, alias]),
      alias.clientId,
      reserved,
    ),
  ).toEqual({ ok: false, code: "server_configuration_error" });
});
