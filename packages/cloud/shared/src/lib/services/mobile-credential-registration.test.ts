/**
 * A mobile checkout returns to the billing return of the native client that
 * owns the caller's credential. That address comes only from the credential's
 * acknowledged grant and the current server registry.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
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
  ELIZA_MOBILE_APP_AUTH_APP_ID: "86000000-0000-4000-8000-0000000000ff",
  ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON: JSON.stringify([ALPHA]),
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
            ...overrides,
          } as Grant),
    ),
  );
}

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
  const registry = (entry: Record<string, unknown>) => ({
    ...ENV,
    ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON: JSON.stringify([entry]),
  });
  expect(await refusal(registry({ ...ALPHA, enabled: false }))).toBe("invalid_client");
  expect(await refusal({ ...ENV, ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON: "[]" })).toBe(
    "invalid_client",
  );
  expect(
    await refusal(registry({ ...ALPHA, redirectUri: "https://eliza.app/other/auth/callback" })),
  ).toBe("invalid_client");
  expect(await refusal(registry({ ...ALPHA, appId: "86000000-0000-4000-8000-000000000003" }))).toBe(
    "invalid_client",
  );
  expect(await refusal({ ...ENV, ENVIRONMENT: "staging" })).toBe("invalid_client");
  expect(await refusal({ ...ENV, ELIZA_MOBILE_APP_AUTH_ENABLED: "false" })).toBe(
    "server_configuration_error",
  );
});
