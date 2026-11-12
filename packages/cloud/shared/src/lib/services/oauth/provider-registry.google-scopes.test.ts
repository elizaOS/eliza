import { expect, test } from "bun:test";
import { OAUTH_PROVIDERS, resolveRequestedScopes } from "./provider-registry";

test("Google mailbox changes are allowed only when explicitly requested", () => {
  const google = OAUTH_PROVIDERS.google;
  const compose = "https://www.googleapis.com/auth/gmail.compose";
  const modify = "https://www.googleapis.com/auth/gmail.modify";
  expect(resolveRequestedScopes(google)).not.toContain(compose);
  expect(resolveRequestedScopes(google)).not.toContain(modify);
  const requested = [...google.defaultScopes, compose, modify];
  expect(resolveRequestedScopes(google, requested)).toEqual(requested);
  expect(() => resolveRequestedScopes(google, ["https://mail.google.com/"])).toThrow();
});
