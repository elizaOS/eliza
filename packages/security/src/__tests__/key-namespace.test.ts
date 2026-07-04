/**
 * Tests the KMS key namespace builders, parser, validation, and version helpers.
 */

import { describe, expect, it } from "vitest";
import {
  baseKeyId,
  isValidKeyId,
  orgKey,
  parseKeyId,
  systemKey,
  userKey,
  withVersion,
} from "../kms/key-namespace.js";

describe("key-namespace", () => {
  it("builds and parses system keys", () => {
    const id = systemKey("webhook-stripe");
    expect(id).toBe("system:webhook-stripe/v1");
    expect(parseKeyId(id)).toEqual({
      scope: "system",
      purpose: "webhook-stripe",
      version: 1,
    });
  });

  it("builds and parses org keys", () => {
    const id = orgKey("acme", "dek", 3);
    expect(id).toBe("org:acme/dek/v3");
    expect(parseKeyId(id)).toEqual({
      scope: "org",
      orgId: "acme",
      purpose: "dek",
      version: 3,
    });
  });

  it("builds and parses user keys", () => {
    const id = userKey("u_42", "connector", 2);
    expect(id).toBe("user:u_42/connector/v2");
    expect(parseKeyId(id)).toEqual({
      scope: "user",
      userId: "u_42",
      purpose: "connector",
      version: 2,
    });
  });

  it("rejects malformed ids", () => {
    expect(isValidKeyId("system:bad spaces/v1")).toBe(false);
    expect(isValidKeyId("system:webhook/foo/v1")).toBe(false);
    expect(isValidKeyId("org:acme/wrong/v1")).toBe(false);
    expect(isValidKeyId("org:acme/dek/v1/extra")).toBe(false);
    expect(isValidKeyId("user:u_42/v1")).toBe(false);
    expect(isValidKeyId("system:webhook-stripe")).toBe(false);
    expect(isValidKeyId("system:webhook-stripe/v0")).toBe(false);
  });

  it("rolls version", () => {
    const id = orgKey("acme", "dek", 1);
    expect(withVersion(id, 5)).toBe("org:acme/dek/v5");
    expect(baseKeyId(id)).toBe("org:acme/dek");
    expect(() => withVersion(id, 0)).toThrow("invalid key version");
    expect(() => withVersion("system:webhook/foo/v1", 2)).toThrow(
      "malformed system key id",
    );
  });

  it("builder helpers reject empty, path-like, and invalid version inputs", () => {
    expect(() => systemKey("")).toThrow("invalid purpose");
    expect(() => systemKey("webhook/foo")).toThrow("invalid purpose");
    expect(() => orgKey("acme/../../other", "dek")).toThrow("invalid org_id");
    expect(() => userKey("", "connector")).toThrow("invalid user_id");
    expect(() => orgKey("acme", "dek", Number.NaN)).toThrow(
      "invalid key version",
    );
  });
});
