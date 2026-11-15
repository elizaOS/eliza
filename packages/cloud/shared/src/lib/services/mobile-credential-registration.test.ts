/**
 * A mobile checkout returns to the billing return of the native client that
 * owns the caller's credential. That address comes only from the credential's
 * acknowledged grant and the current server registry.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mobileAppAuthClientsRepository } from "../../db/repositories/mobile-app-auth-clients";
import { mobileAppAuthGrantsRepository } from "../../db/repositories/mobile-app-auth-grants";
import {
  MobileAppAuthProtocolError,
  mobileBillingReturnUrl,
  resolveMobileCredentialRegistration,
} from "./mobile-app-auth";

type Grant = NonNullable<
  Awaited<ReturnType<typeof mobileAppAuthGrantsRepository.findAcknowledgedByCredentialId>>
>;

const APP_ID = "86000000-0000-4000-8000-000000000001";
const ALPHA = {
  clientId: "ai.alphacompute.alphaphone",
  appId: APP_ID,
  redirectUri: "https://eliza.app/alphaphone/auth/callback",
  enabled: true,
};
const ENV = {
  ENVIRONMENT: "production",
  ELIZA_MOBILE_APP_AUTH_ENABLED: "true",
};
const CREDENTIAL = {
  id: "85000000-0000-4000-8000-000000000001",
  user_id: "81000000-0000-4000-8000-000000000001",
  organization_id: "82000000-0000-4000-8000-000000000001",
  source_app_id: APP_ID,
};

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function grant(overrides: Partial<Grant> | null = {}): void {
  spies.push(
    spyOn(mobileAppAuthGrantsRepository, "findAcknowledgedByCredentialId").mockResolvedValue(
      overrides === null
        ? null
        : ({
            status: "acknowledged",
            credential_id: CREDENTIAL.id,
            user_id: CREDENTIAL.user_id,
            organization_id: CREDENTIAL.organization_id,
            app_id: APP_ID,
            client_id: ALPHA.clientId,
            environment: "production",
            redirect_uri: ALPHA.redirectUri,
            scopes: ["cloud:user"],
            ...overrides,
          } as Grant),
    ),
  );
}

let clientOverride: Partial<typeof ALPHA> | null = {};
beforeEach(() => {
  clientOverride = {};
  spies.push(
    spyOn(mobileAppAuthClientsRepository, "findRegisteredMobileClient").mockImplementation(
      async () => {
        if (clientOverride === null) return null;
        const client = { ...ALPHA, ...clientOverride };
        return {
          client: {
            client_id: client.clientId,
            app_id: client.appId,
            redirect_uri: client.redirectUri,
            enabled: client.enabled,
            credential_ttl_seconds: null,
            android_package_name: null,
            callback_android_package: null,
            android_relations: null,
            android_cert_fingerprints: null,
            browser_sign_in: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
          app: {
            id: client.appId,
            app_url: "https://eliza.app",
            allowed_origins: [client.redirectUri],
            name: "Test",
            description: null,
            logo_url: null,
            website_url: null,
            is_active: true,
            is_approved: true,
          },
        };
      },
    ),
  );
});

async function refusal(env: Record<string, unknown> = ENV): Promise<string> {
  try {
    await resolveMobileCredentialRegistration(env, CREDENTIAL);
  } catch (error) {
    if (error instanceof MobileAppAuthProtocolError) return error.protocolCode;
    throw error;
  }
  throw new Error("expected a refusal");
}

test("the billing return replaces only the sign-in suffix of the registered callback", () => {
  expect(mobileBillingReturnUrl("https://eliza.app/alphaphone/auth/callback")).toBe(
    "https://eliza.app/alphaphone/billing/return",
  );
  expect(mobileBillingReturnUrl("https://eliza.app/auth/callback")).toBe(
    "https://eliza.app/billing/return",
  );
  for (const callback of [
    "https://eliza.app/alphaphone/signed-in",
    "http://eliza.app/alphaphone/auth/callback",
    "https://eliza.app/alphaphone/auth/callback?next=x",
    "https://user@eliza.app/alphaphone/auth/callback",
  ])
    expect(() => mobileBillingReturnUrl(callback)).toThrow(MobileAppAuthProtocolError);
});

test("an acknowledged credential resolves to its registered client", async () => {
  grant();
  const registration = await resolveMobileCredentialRegistration(ENV, CREDENTIAL);
  expect(registration).toMatchObject({
    clientId: "ai.alphacompute.alphaphone",
    appId: APP_ID,
    redirectUri: "https://eliza.app/alphaphone/auth/callback",
  });
  expect(mobileBillingReturnUrl(registration.redirectUri)).toBe(
    "https://eliza.app/alphaphone/billing/return",
  );
});

test("a credential without a matching acknowledged grant has no client", async () => {
  for (const overrides of [
    null,
    { user_id: "81000000-0000-4000-8000-000000000002" },
    { organization_id: "82000000-0000-4000-8000-000000000002" },
    { app_id: "86000000-0000-4000-8000-000000000002" },
  ] as const) {
    grant(overrides);
    expect(await refusal()).toBe("invalid_client");
    for (const spy of spies.splice(0)) spy.mockRestore();
  }
});

test("a disabled, removed or re-pointed registration stops the credential's checkout", async () => {
  grant();
  for (const entry of [
    null,
    { enabled: false },
    { redirectUri: "https://eliza.app/other/auth/callback" },
    { appId: "86000000-0000-4000-8000-000000000003" },
  ]) {
    clientOverride = entry;
    expect(await refusal()).toBe("invalid_client");
  }
  clientOverride = {};
  expect(await refusal({ ...ENV, ENVIRONMENT: "staging" })).toBe("invalid_client");
  expect(await refusal({ ...ENV, ELIZA_MOBILE_APP_AUTH_ENABLED: "false" })).toBe(
    "server_configuration_error",
  );
});
