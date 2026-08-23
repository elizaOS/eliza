/**
 * Unit coverage for canonical SIWS identity validation and session
 * confirmation. Drives the real exports with dependency-injected recording
 * collaborators; deterministic, no network, storage, or DOM involvement.
 */

import { describe, expect, test } from "vitest";
import type { SiwsVerifyResponse } from "../src/lib/api/siws";
import {
  assertCanonicalSiwsIdentity,
  confirmSiwsSession,
} from "../src/lib/context/siws-session";

function buildVerified(): SiwsVerifyResponse {
  return {
    apiKey: "test-api-key",
    address: "11111111111111111111111111111111",
    isNewAccount: false,
    user: {
      id: "user-1",
      wallet_address: "11111111111111111111111111111112",
      organization_id: "org-1",
    },
    organization: { id: "org-1", name: "Org One", slug: "org-one" },
  };
}

function buildCanonicalValue(): {
  user: { id: string; organization_id: string };
  organization: { id: string };
} {
  return {
    user: { id: "user-1", organization_id: "org-1" },
    organization: { id: "org-1" },
  };
}

describe("assertCanonicalSiwsIdentity", () => {
  test("accepts the canonical identity matching its verification", () => {
    const verified = buildVerified();
    const value = buildCanonicalValue();
    expect(() => assertCanonicalSiwsIdentity(verified, value)).not.toThrow();
    expect(assertCanonicalSiwsIdentity(verified, value)).toBeUndefined();
    expect([value.user.id, value.organization.id]).toEqual(["user-1", "org-1"]);
  });

  test("accepts multi-byte identifiers within the byte budget", () => {
    const verified = buildVerified();
    verified.user.id = "üser-1";
    const value = buildCanonicalValue();
    value.user.id = "üser-1";
    expect(() => assertCanonicalSiwsIdentity(verified, value)).not.toThrow();
  });

  test("accepts code points above DEL that are not ASCII control characters", () => {
    const unicodeOrgId = "org\u00801";
    const base = buildVerified();
    const verified: SiwsVerifyResponse = {
      ...base,
      user: { ...base.user, organization_id: unicodeOrgId },
      organization: {
        id: unicodeOrgId,
        name: "Org One",
        slug: "org-one",
      },
    };
    const value = buildCanonicalValue();
    value.user.organization_id = unicodeOrgId;
    value.organization.id = unicodeOrgId;
    expect(value.user.organization_id).toBe(verified.user.organization_id);
    expect(() => assertCanonicalSiwsIdentity(verified, value)).not.toThrow();
  });

  test("accepts identifiers at exactly the 256-byte limit", () => {
    const maxId = "a".repeat(256);
    const verified = buildVerified();
    verified.user.id = maxId;
    const value = buildCanonicalValue();
    value.user.id = maxId;
    expect(() => assertCanonicalSiwsIdentity(verified, value)).not.toThrow();
  });

  test("rejects identifiers beyond the 256-byte limit", () => {
    const overId = "a".repeat(257);
    const verified = buildVerified();
    verified.user.id = overId;
    const value = buildCanonicalValue();
    value.user.id = overId;
    expect(() => assertCanonicalSiwsIdentity(verified, value)).toThrow(
      "Canonical SIWS identity does not match verification",
    );
  });

  test("rejects empty identifier fields", () => {
    const verified = buildVerified();
    const value = buildCanonicalValue();
    value.user.id = "";
    expect(() => assertCanonicalSiwsIdentity(verified, value)).toThrow(
      "Canonical SIWS identity does not match verification",
    );
  });

  test("rejects control characters and DEL in identifier fields", () => {
    for (const poison of ["\u0000", "\n", "\u001f", "\u007f"]) {
      const verified = buildVerified();
      const value = buildCanonicalValue();
      value.organization.id = `${poison}org-1`;
      expect(() => assertCanonicalSiwsIdentity(verified, value)).toThrow(
        "Canonical SIWS identity does not match verification",
      );
    }
  });

  test("rejects non-record payloads including arrays and primitives", () => {
    const verified = buildVerified();
    for (const value of [
      null,
      undefined,
      "user-1",
      42,
      [],
      [{ user: {}, organization: {} }],
    ]) {
      expect(() => assertCanonicalSiwsIdentity(verified, value)).toThrow(
        "Canonical SIWS identity does not match verification",
      );
    }
  });

  test("rejects payloads whose user or organization is not a record", () => {
    const verified = buildVerified();
    expect(() =>
      assertCanonicalSiwsIdentity(verified, {
        organization: { id: "org-1" },
      }),
    ).toThrow("Canonical SIWS identity does not match verification");
    expect(() =>
      assertCanonicalSiwsIdentity(verified, {
        user: ["user-1"],
        organization: { id: "org-1" },
      }),
    ).toThrow("Canonical SIWS identity does not match verification");
    expect(() =>
      assertCanonicalSiwsIdentity(verified, {
        user: { id: "user-1", organization_id: "org-1" },
      }),
    ).toThrow("Canonical SIWS identity does not match verification");
    expect(() =>
      assertCanonicalSiwsIdentity(verified, {
        user: { id: "user-1", organization_id: "org-1" },
        organization: "org-1",
      }),
    ).toThrow("Canonical SIWS identity does not match verification");
  });

  test("rejects identifiers that disagree with the verification response", () => {
    const verified = buildVerified();

    const wrongUserId = buildCanonicalValue();
    wrongUserId.user.id = "user-2";
    expect(() => assertCanonicalSiwsIdentity(verified, wrongUserId)).toThrow(
      "Canonical SIWS identity does not match verification",
    );

    const wrongOrganizationId = buildCanonicalValue();
    wrongOrganizationId.organization.id = "org-2";
    expect(() =>
      assertCanonicalSiwsIdentity(verified, wrongOrganizationId),
    ).toThrow("Canonical SIWS identity does not match verification");

    const wrongMembership = buildCanonicalValue();
    wrongMembership.user.organization_id = "org-9";
    expect(() =>
      assertCanonicalSiwsIdentity(verified, wrongMembership),
    ).toThrow("Canonical SIWS identity does not match verification");
  });

  test("rejects non-string identifier values", () => {
    const verified = buildVerified();
    const value = buildCanonicalValue();
    (
      value.user as unknown as { id: string; organization_id: number }
    ).organization_id = 7;
    expect(() => assertCanonicalSiwsIdentity(verified, value)).toThrow(
      "Canonical SIWS identity does not match verification",
    );
  });

  test("rejects every payload when verification carries no organization", () => {
    const verified = { ...buildVerified(), organization: null };
    expect(() =>
      assertCanonicalSiwsIdentity(verified, buildCanonicalValue()),
    ).toThrow("Canonical SIWS identity does not match verification");
  });
});

describe("confirmSiwsSession", () => {
  interface RecordedUser {
    plan: string;
  }

  function createRecordingDependencies() {
    const events: string[] = [];
    const dependencies = {
      loadCanonicalUser: async (token: string): Promise<RecordedUser> => {
        events.push(`load:${token}`);
        return { plan: "pro" };
      },
      validateCanonicalUser: (value: RecordedUser) => {
        events.push(`validate:${value.plan}`);
      },
      isCurrentAttempt: () => {
        events.push("attempt");
        return true;
      },
      storeToken: (token: string) => {
        events.push(`store:${token}`);
      },
      publishCanonicalUser: (value: RecordedUser) => {
        events.push(`publish:${value.plan}`);
      },
    };
    return { dependencies, events };
  }

  test("stores the bearer token before publishing the loaded user", async () => {
    const { dependencies, events } = createRecordingDependencies();
    await confirmSiwsSession("key-123", dependencies);
    expect(events).toEqual([
      "load:key-123",
      "validate:pro",
      "attempt",
      "store:key-123",
      "publish:pro",
    ]);
  });

  test("consults every collaborator exactly once with the right arguments", async () => {
    let loadCalls = 0;
    const validateArguments: RecordedUser[] = [];
    const storeTokens: string[] = [];
    const publishedUsers: RecordedUser[] = [];
    let attemptChecks = 0;
    await confirmSiwsSession("key-abc", {
      loadCanonicalUser: async (token) => {
        loadCalls += 1;
        expect(token).toBe("key-abc");
        return { plan: "team" };
      },
      validateCanonicalUser: (value) => {
        validateArguments.push(value);
      },
      isCurrentAttempt: () => {
        attemptChecks += 1;
        return true;
      },
      storeToken: (token) => {
        storeTokens.push(token);
      },
      publishCanonicalUser: (value) => {
        publishedUsers.push(value);
      },
    });
    expect(loadCalls).toBe(1);
    expect(validateArguments).toEqual([{ plan: "team" }]);
    expect(attemptChecks).toBe(1);
    expect(storeTokens).toEqual(["key-abc"]);
    expect(publishedUsers).toEqual([{ plan: "team" }]);
  });

  test("propagates load failure without validating, storing, or publishing", async () => {
    const { dependencies, events } = createRecordingDependencies();
    dependencies.loadCanonicalUser = async (token) => {
      events.push(`load:${token}`);
      throw new Error("verification request failed");
    };
    await expect(confirmSiwsSession("key-123", dependencies)).rejects.toThrow(
      "verification request failed",
    );
    expect(events).toEqual(["load:key-123"]);
  });

  test("propagates validator failure without consulting staleness or persistence", async () => {
    const { dependencies, events } = createRecordingDependencies();
    dependencies.validateCanonicalUser = () => {
      events.push("validate:pro");
      throw new Error("canonical user failed validation");
    };
    await expect(confirmSiwsSession("key-123", dependencies)).rejects.toThrow(
      "canonical user failed validation",
    );
    expect(events).toEqual(["load:key-123", "validate:pro"]);
  });

  test("refuses to persist or publish a superseded attempt", async () => {
    const { dependencies, events } = createRecordingDependencies();
    dependencies.isCurrentAttempt = () => {
      events.push("attempt");
      return false;
    };
    await expect(confirmSiwsSession("key-123", dependencies)).rejects.toThrow(
      "SIWS session attempt was superseded",
    );
    expect(events).toEqual(["load:key-123", "validate:pro", "attempt"]);
  });

  test("keeps identity unpublished when token storage fails", async () => {
    const { dependencies, events } = createRecordingDependencies();
    dependencies.storeToken = (token) => {
      events.push(`store:${token}`);
      throw new Error("storage quota exceeded");
    };
    await expect(confirmSiwsSession("key-123", dependencies)).rejects.toThrow(
      "storage quota exceeded",
    );
    expect(events).toEqual([
      "load:key-123",
      "validate:pro",
      "attempt",
      "store:key-123",
    ]);
  });

  test("surfaces publisher failure after the token is already stored", async () => {
    const { dependencies, events } = createRecordingDependencies();
    dependencies.publishCanonicalUser = (value) => {
      events.push(`publish:${value.plan}`);
      throw new Error("session bus closed");
    };
    await expect(confirmSiwsSession("key-123", dependencies)).rejects.toThrow(
      "session bus closed",
    );
    expect(events).toEqual([
      "load:key-123",
      "validate:pro",
      "attempt",
      "store:key-123",
      "publish:pro",
    ]);
    expect(events.indexOf("store:key-123")).toBeLessThan(
      events.indexOf("publish:pro"),
    );
  });
});
