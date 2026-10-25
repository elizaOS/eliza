import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateMobileAppAuthRegistrationRow,
  resolveMobileAppAuthRegistrationSelection,
} from "./verify-mobile-app-auth-registration.ts";
const id = "22222222-2222-4222-8222-222222222222",
  primary = "11111111-1111-4111-8111-111111111111";
const entry = {
  clientId: "org.example.reader",
  appId: id,
  redirectUri: "https://eliza.app/reader/auth/callback",
  enabled: true,
};
const { target } = resolveMobileAppAuthRegistrationSelection(
  entry.clientId,
  "production",
  JSON.stringify([entry]),
  primary,
);
function row(patch = {}) {
  return {
    id,
    app_url: "https://eliza.app",
    allowed_origins: [entry.redirectUri],
    is_active: true,
    is_approved: true,
    organization_exists: true,
    organization_is_active: true,
    creator_exists: true,
    creator_is_active: true,
    creator_matches_organization: true,
    creator_role: "owner",
    has_api_key_id: true,
    api_key_row_absent: true,
    api_key_row_revoked: false,
    api_key_ownership_matches: false,
    matching_active_approved_registration_count: 1,
    ...patch,
  };
}
test("homepage metadata accepts canonical same-origin paths and query/fragment metadata", () => {
  for (const app_url of [
    "https://eliza.app",
    "https://eliza.app/",
    "https://eliza.app/reader",
    "https://eliza.app/reader/auth/callback",
    "https://eliza.app/home?native=true#intro",
  ])
    assert.doesNotThrow(() =>
      validateMobileAppAuthRegistrationRow(row({ app_url }), id, target),
    );
});
test("hostile or foreign homepage URLs cannot pass the first-party origin check", () => {
  for (const app_url of [
    "",
    "not-a-url",
    "http://eliza.app/home",
    "javascript:alert(1)",
    "https://eliza.app.evil.example/home",
    "https://evil.example/",
    "https://eliza.app:444/home",
    "https://user:pass@eliza.app/home",
    "https://eliza.app@evil.example/home",
    "https://*.eliza.app/home",
    "https://eliza.app/*",
    "https://127.0.0.1/home",
    "https://localhost/home",
  ])
    assert.throws(
      () => validateMobileAppAuthRegistrationRow(row({ app_url }), id, target),
      /apps.app_url/,
    );
});
test("homepage paths never replace the sole exact registered callback or owner/client checks", () => {
  for (const allowed_origins of [
    ["https://eliza.app"],
    ["https://eliza.app/reader/other"],
    [entry.redirectUri + "/"],
    [entry.redirectUri + "?next=evil"],
    [entry.redirectUri + "#fragment"],
    ["https://evil.example/callback"],
    ["https://*.eliza.app"],
    [entry.redirectUri, "https://eliza.app/extra"],
  ])
    assert.throws(
      () =>
        validateMobileAppAuthRegistrationRow(
          row({ app_url: entry.redirectUri, allowed_origins }),
          id,
          target,
        ),
      /apps.allowed_origins/,
    );
  for (const patch of [
    { is_active: false },
    { is_approved: false },
    { creator_matches_organization: false },
    { organization_is_active: false },
    { creator_role: "member" },
  ])
    assert.throws(() =>
      validateMobileAppAuthRegistrationRow(row(patch), id, target),
    );
  assert.throws(
    () => validateMobileAppAuthRegistrationRow(row(), primary, target),
    /configured app UUID/,
  );
});
