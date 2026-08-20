/**
 * Deterministic tests for the Google OAuth nested-token merge bound. No live
 * Google API: the walker is the production credential flatten.
 */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

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

  it("translates revoked root proxies to the typed boundary failure", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(() => mergeCredentialObject({}, proxy)).toThrowError(
      expect.objectContaining({ code: GOOGLE_OAUTH_CREDENTIAL_UNBOUNDED })
    );
  });

  it("never invokes source Proxy get or has traps", () => {
    let getInvocations = 0;
    let hasInvocations = 0;
    const source = new Proxy(
      {
        tokens: { refresh_token: "nested-refresh" },
        access_token: "outer-access",
      },
      {
        get() {
          getInvocations += 1;
          throw new Error("get trap must not run");
        },
        has() {
          hasInvocations += 1;
          throw new Error("has trap must not run");
        },
      }
    );
    const credentials: OauthCredentialFields = {};

    mergeCredentialObject(credentials, source);

    expect(credentials).toEqual({
      access_token: "outer-access",
      refresh_token: "nested-refresh",
    });
    expect(getInvocations).toBe(0);
    expect(hasInvocations).toBe(0);
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

  it("does not commit partial credentials when reflection fails late", () => {
    const reflectionError = new Error("scope reflection denied");
    const scopes = new Proxy(["gmail.read"], {
      getOwnPropertyDescriptor() {
        throw reflectionError;
      },
    });
    const credentials: OauthCredentialFields = { refresh_token: "existing-refresh" };

    expect(() =>
      mergeCredentialObject(credentials, {
        access_token: "uncommitted-access",
        refresh_token: "uncommitted-refresh",
        scopes,
      })
    ).toThrowError(expect.objectContaining({ code: GOOGLE_OAUTH_CREDENTIAL_UNBOUNDED }));
    expect(credentials).toEqual({ refresh_token: "existing-refresh" });
  });

  it("does not retain an invalid scope length value in error context", () => {
    const sensitiveLength = { access_token: "must-not-enter-context" };
    const scopes: unknown[] = [];
    const nativeDescriptor = Object.getOwnPropertyDescriptor;
    const descriptorSpy = vi
      .spyOn(Object, "getOwnPropertyDescriptor")
      .mockImplementation((target, key) => {
        if (target === scopes && key === "length") {
          return { value: sensitiveLength };
        }
        return nativeDescriptor(target, key);
      });

    try {
      mergeCredentialObject({}, { scopes });
      expect.unreachable("invalid scope length should fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).context).toEqual({
        operation: "readScopeArray",
        reason: "invalidLength",
      });
      expect(JSON.stringify((error as ElizaError).context)).not.toContain("must-not-enter-context");
    } finally {
      descriptorSpy.mockRestore();
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
