/**
 * Isolated unit coverage for the thin-Steward path predicates. The module
 * has no queue, comparator, or capacity: the live branches are trailing-slash
 * collapse, exact-path membership, and method dispatch. Tests import the
 * production helpers and assert the values they return.
 */
import { describe, expect, test } from "vitest";
import {
  isThinStewardEmailAuthPath,
  isThinStewardPasskeyLoginOptionsPath,
  isThinStewardPath,
  isThinStewardPublicPath,
} from "./public-paths";

const PUBLIC_PATHS = [
  "/steward/auth/providers",
  "/steward/tenants/config",
] as const;

const EMAIL_AUTH_PATHS = [
  "/steward/auth/email/send",
  "/steward/auth/email/code/verify",
  "/steward/auth/email/status",
  "/steward/auth/email/otp/send",
  "/steward/auth/email/otp/verify",
] as const;

const PASSKEY_LOGIN_OPTIONS = "/steward/auth/passkey/login/options";

const NEAR_MISS_PATHS = [
  "",
  "/",
  "///",
  "/steward",
  "/steward/",
  "/steward/auth",
  "/steward/auth/",
  "/steward/auth/providers/extra",
  "/steward/auth/provider",
  "/steward/auth/providersx",
  "/steward/tenants",
  "/steward/tenants/configs",
  "/steward/auth/email",
  "/steward/auth/email/verify",
  "/steward/auth/email/code",
  "/steward/auth/email/otp",
  "/steward/auth/passkey/login/verify",
  "/steward/auth/passkey/register/options",
  "/steward/auth/passkey/register/verify",
  "/steward/vault/keys",
  "/api/v1/oauth/providers",
  "/Steward/auth/providers",
  "/STEWARD/auth/providers",
  "/steward/auth/Providers",
  " /steward/auth/providers",
  "/steward/auth/providers ",
  "/steward//auth/providers",
  "/steward/auth/providers?x=1",
  "/steward/auth/email/send?next=1",
] as const;

function withTrailingSlashes(pathname: string, count: number): string {
  return `${pathname}${"/".repeat(count)}`;
}

describe("isThinStewardPublicPath", () => {
  test("matches only the two login-critical GET discovery paths", () => {
    for (const pathname of PUBLIC_PATHS) {
      expect(isThinStewardPublicPath(pathname)).toBe(true);
    }
  });

  test("collapses any number of trailing slashes before comparing", () => {
    for (const pathname of PUBLIC_PATHS) {
      expect(isThinStewardPublicPath(withTrailingSlashes(pathname, 1))).toBe(
        true,
      );
      expect(isThinStewardPublicPath(withTrailingSlashes(pathname, 3))).toBe(
        true,
      );
    }
    expect(
      isThinStewardPublicPath(
        withTrailingSlashes("/steward/auth/providers", 100_000),
      ),
    ).toBe(true);
  });

  test("treats the empty string and slash-only paths as root, which is not public", () => {
    expect(isThinStewardPublicPath("")).toBe(false);
    expect(isThinStewardPublicPath("/")).toBe(false);
    expect(isThinStewardPublicPath("///")).toBe(false);
  });

  test("rejects email, passkey, and other Steward or API near-misses", () => {
    for (const pathname of EMAIL_AUTH_PATHS) {
      expect(isThinStewardPublicPath(pathname)).toBe(false);
    }
    expect(isThinStewardPublicPath(PASSKEY_LOGIN_OPTIONS)).toBe(false);
    for (const pathname of NEAR_MISS_PATHS) {
      expect(isThinStewardPublicPath(pathname)).toBe(false);
    }
  });
});

describe("isThinStewardEmailAuthPath", () => {
  test("matches each of the five pre-auth email mutation legs", () => {
    for (const pathname of EMAIL_AUTH_PATHS) {
      expect(isThinStewardEmailAuthPath(pathname)).toBe(true);
    }
  });

  test("collapses trailing slashes on every email leg", () => {
    for (const pathname of EMAIL_AUTH_PATHS) {
      expect(isThinStewardEmailAuthPath(withTrailingSlashes(pathname, 1))).toBe(
        true,
      );
      expect(isThinStewardEmailAuthPath(withTrailingSlashes(pathname, 4))).toBe(
        true,
      );
    }
    expect(
      isThinStewardEmailAuthPath(
        withTrailingSlashes("/steward/auth/email/send", 100_000),
      ),
    ).toBe(true);
  });

  test("does not match public discovery or passkey-bootstrap paths", () => {
    for (const pathname of PUBLIC_PATHS) {
      expect(isThinStewardEmailAuthPath(pathname)).toBe(false);
    }
    expect(isThinStewardEmailAuthPath(PASSKEY_LOGIN_OPTIONS)).toBe(false);
  });

  test("rejects empty, root, prefix, suffix, and case-variant near-misses", () => {
    for (const pathname of NEAR_MISS_PATHS) {
      expect(isThinStewardEmailAuthPath(pathname)).toBe(false);
    }
    expect(isThinStewardEmailAuthPath("/steward/auth/email/send/extra")).toBe(
      false,
    );
    expect(isThinStewardEmailAuthPath("/steward/auth/email/otp/verify/x")).toBe(
      false,
    );
  });
});

describe("isThinStewardPasskeyLoginOptionsPath", () => {
  test("matches only the pre-WebAuthn login-options path", () => {
    expect(isThinStewardPasskeyLoginOptionsPath(PASSKEY_LOGIN_OPTIONS)).toBe(
      true,
    );
  });

  test("collapses trailing slashes on the login-options path", () => {
    expect(
      isThinStewardPasskeyLoginOptionsPath(
        withTrailingSlashes(PASSKEY_LOGIN_OPTIONS, 1),
      ),
    ).toBe(true);
    expect(
      isThinStewardPasskeyLoginOptionsPath(
        withTrailingSlashes(PASSKEY_LOGIN_OPTIONS, 8),
      ),
    ).toBe(true);
  });

  test("leaves registration and verification on the full app", () => {
    expect(
      isThinStewardPasskeyLoginOptionsPath(
        "/steward/auth/passkey/login/verify",
      ),
    ).toBe(false);
    expect(
      isThinStewardPasskeyLoginOptionsPath(
        "/steward/auth/passkey/register/options",
      ),
    ).toBe(false);
    expect(
      isThinStewardPasskeyLoginOptionsPath(
        "/steward/auth/passkey/register/verify",
      ),
    ).toBe(false);
    expect(
      isThinStewardPasskeyLoginOptionsPath(`${PASSKEY_LOGIN_OPTIONS}/extra`),
    ).toBe(false);
  });

  test("rejects public, email, empty, and case-variant paths", () => {
    for (const pathname of PUBLIC_PATHS) {
      expect(isThinStewardPasskeyLoginOptionsPath(pathname)).toBe(false);
    }
    for (const pathname of EMAIL_AUTH_PATHS) {
      expect(isThinStewardPasskeyLoginOptionsPath(pathname)).toBe(false);
    }
    expect(isThinStewardPasskeyLoginOptionsPath("")).toBe(false);
    expect(isThinStewardPasskeyLoginOptionsPath("/")).toBe(false);
    expect(
      isThinStewardPasskeyLoginOptionsPath(
        "/steward/auth/passkey/Login/options",
      ),
    ).toBe(false);
  });
});

describe("isThinStewardPath", () => {
  test("GET and HEAD are eligible only for the public discovery paths", () => {
    for (const method of ["GET", "HEAD", "get", "head", "Get", "Head"]) {
      for (const pathname of PUBLIC_PATHS) {
        expect(isThinStewardPath(method, pathname)).toBe(true);
        expect(
          isThinStewardPath(method, withTrailingSlashes(pathname, 2)),
        ).toBe(true);
      }
      for (const pathname of EMAIL_AUTH_PATHS) {
        expect(isThinStewardPath(method, pathname)).toBe(false);
      }
      expect(isThinStewardPath(method, PASSKEY_LOGIN_OPTIONS)).toBe(false);
      expect(isThinStewardPath(method, "/steward/vault/keys")).toBe(false);
    }
  });

  test("POST is eligible only for the email legs and passkey login-options", () => {
    for (const method of ["POST", "post", "Post"]) {
      for (const pathname of EMAIL_AUTH_PATHS) {
        expect(isThinStewardPath(method, pathname)).toBe(true);
      }
      expect(isThinStewardPath(method, PASSKEY_LOGIN_OPTIONS)).toBe(true);
      expect(
        isThinStewardPath(
          method,
          withTrailingSlashes(PASSKEY_LOGIN_OPTIONS, 1),
        ),
      ).toBe(true);
      for (const pathname of PUBLIC_PATHS) {
        expect(isThinStewardPath(method, pathname)).toBe(false);
      }
      expect(
        isThinStewardPath(method, "/steward/auth/passkey/login/verify"),
      ).toBe(false);
      expect(
        isThinStewardPath(method, "/steward/auth/passkey/register/options"),
      ).toBe(false);
      expect(isThinStewardPath(method, "/steward/vault/keys")).toBe(false);
    }
  });

  test("OPTIONS is eligible for public, email, and passkey-login-options paths", () => {
    for (const method of ["OPTIONS", "options", "Options"]) {
      for (const pathname of PUBLIC_PATHS) {
        expect(isThinStewardPath(method, pathname)).toBe(true);
      }
      for (const pathname of EMAIL_AUTH_PATHS) {
        expect(isThinStewardPath(method, pathname)).toBe(true);
      }
      expect(isThinStewardPath(method, PASSKEY_LOGIN_OPTIONS)).toBe(true);
      expect(isThinStewardPath(method, "/steward/vault/keys")).toBe(false);
      expect(
        isThinStewardPath(method, "/steward/auth/passkey/register/options"),
      ).toBe(false);
      expect(isThinStewardPath(method, "")).toBe(false);
      expect(isThinStewardPath(method, "/")).toBe(false);
    }
  });

  test("methods outside GET, HEAD, POST, and OPTIONS never match", () => {
    const eligible = [
      ...PUBLIC_PATHS,
      ...EMAIL_AUTH_PATHS,
      PASSKEY_LOGIN_OPTIONS,
    ];
    for (const method of [
      "PUT",
      "PATCH",
      "DELETE",
      "TRACE",
      "CONNECT",
      "",
      " GET",
      "GET ",
    ]) {
      for (const pathname of eligible) {
        expect(isThinStewardPath(method, pathname)).toBe(false);
      }
    }
  });
});
