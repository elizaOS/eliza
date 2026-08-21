/**
 * Deterministic tests for the Google OAuth nested-token merge bound. No live
 * Google API: the walker is the production credential flatten.
 */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import {
  GOOGLE_OAUTH_CREDENTIAL_UNBOUNDED,
  MAX_OAUTH_CREDENTIAL_DEPTH,
  MAX_OAUTH_CREDENTIAL_NODES,
  mergeCredentialObject,
  type OauthCredentialFields,
} from "./oauth-credential-merge";

function nestTokens(depth: number): unknown {
  let value: unknown = { access_token: "tok" };
  for (let index = 0; index < depth; index += 1) {
    value = { tokens: value };
  }
  return value;
}

describe("mergeCredentialObject", () => {
  it("flattens honest nested token objects", () => {
    const credentials: OauthCredentialFields = {};
    mergeCredentialObject(credentials, {
      tokens: { access_token: "a", refresh_token: "r" },
    });
    expect(credentials.access_token).toBe("a");
    expect(credentials.refresh_token).toBe("r");
  });

  it(`accepts a ${MAX_OAUTH_CREDENTIAL_DEPTH}-deep tokens nest`, () => {
    const credentials: OauthCredentialFields = {};
    mergeCredentialObject(credentials, nestTokens(MAX_OAUTH_CREDENTIAL_DEPTH));
    expect(credentials.access_token).toBe("tok");
  });

  it(`throws ${GOOGLE_OAUTH_CREDENTIAL_UNBOUNDED} one past depth ${MAX_OAUTH_CREDENTIAL_DEPTH}`, () => {
    try {
      mergeCredentialObject({}, nestTokens(MAX_OAUTH_CREDENTIAL_DEPTH + 1));
      expect.unreachable("merge should fail closed on over-budget depth");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GOOGLE_OAUTH_CREDENTIAL_UNBOUNDED);
    }
  });

  it(`throws ${GOOGLE_OAUTH_CREDENTIAL_UNBOUNDED} past ${MAX_OAUTH_CREDENTIAL_NODES} sparse scopes`, () => {
    const sparse: unknown[] = [];
    sparse[MAX_OAUTH_CREDENTIAL_NODES] = "scope";
    try {
      mergeCredentialObject({}, { access_token: "a", scopes: sparse });
      expect.unreachable("merge should fail closed on over-budget sparse scopes");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GOOGLE_OAUTH_CREDENTIAL_UNBOUNDED);
    }
  });

  it("does not invoke indexed scope accessors and fails closed", () => {
    let invoked = 0;
    const scopes = ["gmail.read"];
    Object.defineProperty(scopes, "1", {
      enumerable: true,
      get() {
        invoked += 1;
        return "drive.readonly";
      },
    });

    expect(() => mergeCredentialObject({}, { scopes })).toThrowError(
      expect.objectContaining({ code: GOOGLE_OAUTH_CREDENTIAL_UNBOUNDED })
    );
    expect(invoked).toBe(0);
  });

  it("translates revoked scope proxies to the typed boundary failure", () => {
    const { proxy, revoke } = Proxy.revocable([], {});
    revoke();

    try {
      mergeCredentialObject({}, { scopes: proxy });
      expect.unreachable("revoked scope proxy should fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GOOGLE_OAUTH_CREDENTIAL_UNBOUNDED);
      expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(TypeError);
    }
  });

  it("translates a revoked root proxy without changing existing credentials", () => {
    const credentials: OauthCredentialFields = {
      access_token: "existing-access",
      scope: "existing.scope",
    };
    const before = { ...credentials };
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    try {
      mergeCredentialObject(credentials, proxy);
      expect.unreachable("revoked root proxy should fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GOOGLE_OAUTH_CREDENTIAL_UNBOUNDED);
      expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(TypeError);
    }

    expect(credentials).toEqual(before);
  });

  it("does not invoke ordinary source get or has traps", () => {
    let gets = 0;
    let hasChecks = 0;
    const source = new Proxy(
      {
        access_token: "safe-access",
        refresh_token: "safe-refresh",
      },
      {
        get() {
          gets += 1;
          throw new Error("ordinary get must not run");
        },
        has() {
          hasChecks += 1;
          throw new Error("ordinary has must not run");
        },
      }
    );
    const credentials: OauthCredentialFields = {};

    mergeCredentialObject(credentials, source);

    expect(credentials).toMatchObject({
      access_token: "safe-access",
      refresh_token: "safe-refresh",
    });
    expect(gets).toBe(0);
    expect(hasChecks).toBe(0);
  });

  it("translates hostile scope descriptor reflection without invoking access", () => {
    const reflectionError = new Error("descriptor reflection denied");
    const scopes = new Proxy(["gmail.read"], {
      getOwnPropertyDescriptor() {
        throw reflectionError;
      },
    });

    try {
      mergeCredentialObject({}, { scopes });
      expect.unreachable("hostile scope descriptor should fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GOOGLE_OAUTH_CREDENTIAL_UNBOUNDED);
      expect((error as Error & { cause?: unknown }).cause).toBe(reflectionError);
    }
  });

  it("leaves existing credentials unchanged when a late reflection failure aborts the walk", () => {
    const credentials: OauthCredentialFields = {
      access_token: "existing-access",
      refresh_token: "existing-refresh",
      scope: "existing.scope",
      expiry_date: 123,
    };
    const before = { ...credentials };
    const reflectionError = new Error("late descriptor reflection denied");
    const scopes = new Proxy(["gmail.read"], {
      getOwnPropertyDescriptor() {
        throw reflectionError;
      },
    });

    try {
      mergeCredentialObject(credentials, {
        tokens: {
          access_token: "staged-access",
          refresh_token: "staged-refresh",
        },
        scopes,
      });
      expect.unreachable("late reflection failure should abort the whole merge");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GOOGLE_OAUTH_CREDENTIAL_UNBOUNDED);
      expect((error as Error & { cause?: unknown }).cause).toBe(reflectionError);
    }

    expect(credentials).toEqual(before);
  });

  it("uses fixed serializable context for an invalid reflected scope length", () => {
    const credentialControlledLength = {
      access_token: "must-not-enter-error-context",
    };
    const scopes = new Proxy([], {
      getOwnPropertyDescriptor(target, key) {
        if (key === "length") {
          return {
            configurable: false,
            enumerable: false,
            value: credentialControlledLength,
            writable: true,
          };
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    try {
      mergeCredentialObject({}, { scopes });
      expect.unreachable("invalid reflected length should fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GOOGLE_OAUTH_CREDENTIAL_UNBOUNDED);
      expect((error as ElizaError).context).toEqual({
        operation: "readScopes",
        reason: "invalidLength",
      });
      expect(JSON.stringify((error as ElizaError).context)).not.toContain(
        credentialControlledLength.access_token
      );
    }
  });

  it("translates revoked expiry reflection to the typed boundary failure", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    try {
      mergeCredentialObject({}, { expiry_date: proxy });
      expect.unreachable("revoked expiry proxy should fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GOOGLE_OAUTH_CREDENTIAL_UNBOUNDED);
      expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(TypeError);
    }
  });

  it("preserves sparse scopes and nested-then-outer token precedence", () => {
    const scopes: unknown[] = ["gmail.read", 42, "drive.readonly"];
    delete scopes[1];
    const credentials: OauthCredentialFields = {};

    mergeCredentialObject(credentials, {
      tokens: {
        access_token: "nested-access",
        refresh_token: "nested-refresh",
        scope: "nested.scope",
      },
      accessToken: "outer-access",
      scopes,
    });

    expect(credentials).toMatchObject({
      access_token: "outer-access",
      refresh_token: "nested-refresh",
      scope: "gmail.read drive.readonly",
    });
  });

  it("throws on a cyclic tokens object without hanging", () => {
    const cyclic: { tokens?: unknown } = {};
    cyclic.tokens = cyclic;
    const started = performance.now();
    try {
      mergeCredentialObject({}, cyclic);
      expect.unreachable("merge should fail closed on a cycle");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GOOGLE_OAUTH_CREDENTIAL_UNBOUNDED);
    }
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("does not invoke accessors while merging", () => {
    let invoked = 0;
    const hostile = {
      access_token: "a",
      get tokens() {
        invoked += 1;
        return nestTokens(20_000);
      },
    };
    const credentials: OauthCredentialFields = {};
    mergeCredentialObject(credentials, hostile);
    expect(invoked).toBe(0);
    expect(credentials.access_token).toBe("a");
  });

  it("fails closed on an 8k nest in under 50ms instead of RangeError", () => {
    const started = performance.now();
    try {
      mergeCredentialObject({}, nestTokens(8_000));
      expect.unreachable("merge should fail closed on an 8k nest");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GOOGLE_OAUTH_CREDENTIAL_UNBOUNDED);
      expect((error as Error).name).not.toBe("RangeError");
    }
    expect(performance.now() - started).toBeLessThan(50);
  });
});
