import { expect, test } from "bun:test";
import {
  matchesOAuthLinkPkce,
  validOAuthLinkPkce,
} from "../api/services/oauth-link-pkce";

const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

test("OAuth linking verifies the RFC 7636 S256 vector", () => {
  expect(validOAuthLinkPkce(challenge, "S256")).toBe(true);
  expect(matchesOAuthLinkPkce(challenge, "S256", verifier)).toBe(true);
  for (const value of [
    "",
    "x".repeat(42),
    "x".repeat(129),
    "x".repeat(43),
    `${verifier} `,
    null,
  ]) {
    expect(matchesOAuthLinkPkce(challenge, "S256", value)).toBe(false);
  }
});

test("OAuth linking rejects partial, malformed and downgraded bindings", () => {
  for (const [value, method] of [
    [challenge, undefined],
    [undefined, "S256"],
    [challenge, "plain"],
    ["", "S256"],
    [`${challenge}=`, "S256"],
    [null, null],
    [43, "S256"],
  ]) {
    expect(validOAuthLinkPkce(value, method)).toBe(false);
    expect(matchesOAuthLinkPkce(value, method, verifier)).toBe(false);
  }
});

test("legacy omission cannot accept a verifier unrelated to a stored challenge", () => {
  expect(validOAuthLinkPkce(undefined, undefined)).toBe(true);
  expect(matchesOAuthLinkPkce(undefined, undefined, "")).toBe(true);
  expect(matchesOAuthLinkPkce(undefined, undefined, verifier)).toBe(false);
});
