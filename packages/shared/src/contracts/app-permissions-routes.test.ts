import { describe, expect, it } from "vitest";
import {
  AppPermissionsViewSchema,
  ListAppPermissionsResponseSchema,
  PutAppPermissionsRequestSchema,
} from "./app-permissions-routes.js";

const VALID_VIEW = {
  slug: "demo",
  trust: "external",
  isolation: "worker",
  requestedPermissions: { fs: { read: ["**"] } },
  recognisedNamespaces: ["fs"],
  grantedNamespaces: ["fs"],
  grantedAt: "2026-05-10T20:00:00.000Z",
};

describe("AppPermissionsViewSchema", () => {
  it("accepts a fully populated view", () => {
    const parsed = AppPermissionsViewSchema.parse(VALID_VIEW);
    expect(parsed).toEqual(VALID_VIEW);
  });

  it("accepts requestedPermissions=null and grantedAt=null (no grant yet)", () => {
    const parsed = AppPermissionsViewSchema.parse({
      ...VALID_VIEW,
      requestedPermissions: null,
      grantedAt: null,
    });
    expect(parsed.requestedPermissions).toBeNull();
    expect(parsed.grantedAt).toBeNull();
  });

  it("rejects an unknown trust value", () => {
    expect(() =>
      AppPermissionsViewSchema.parse({ ...VALID_VIEW, trust: "verified" }),
    ).toThrow();
  });

  it("rejects an unknown isolation value", () => {
    expect(() =>
      AppPermissionsViewSchema.parse({
        ...VALID_VIEW,
        isolation: "subprocess",
      }),
    ).toThrow();
  });

  it("rejects an unknown granted namespace", () => {
    expect(() =>
      AppPermissionsViewSchema.parse({
        ...VALID_VIEW,
        grantedNamespaces: ["fs", "capabilities"],
      }),
    ).toThrow();
  });

  it("rejects extra unknown top-level fields (strict)", () => {
    expect(() =>
      AppPermissionsViewSchema.parse({ ...VALID_VIEW, extra: 42 }),
    ).toThrow();
  });

  it("rejects missing required fields", () => {
    const { trust: _trust, ...withoutTrust } = VALID_VIEW;
    expect(() => AppPermissionsViewSchema.parse(withoutTrust)).toThrow();
  });
});

describe("ListAppPermissionsResponseSchema", () => {
  it("accepts an empty array", () => {
    expect(ListAppPermissionsResponseSchema.parse([])).toEqual([]);
  });

  it("accepts an array of valid views", () => {
    const parsed = ListAppPermissionsResponseSchema.parse([
      VALID_VIEW,
      { ...VALID_VIEW, slug: "other" },
    ]);
    expect(parsed).toHaveLength(2);
  });

  it("rejects a non-array root", () => {
    expect(() => ListAppPermissionsResponseSchema.parse(VALID_VIEW)).toThrow();
  });
});

describe("PutAppPermissionsRequestSchema", () => {
  it("accepts a string-array namespaces field", () => {
    const parsed = PutAppPermissionsRequestSchema.parse({
      namespaces: ["fs", "net"],
    });
    expect(parsed.namespaces).toEqual(["fs", "net"]);
  });

  it("accepts an empty array (used to revoke all)", () => {
    const parsed = PutAppPermissionsRequestSchema.parse({ namespaces: [] });
    expect(parsed.namespaces).toEqual([]);
  });

  it("rejects a missing namespaces field", () => {
    expect(() => PutAppPermissionsRequestSchema.parse({})).toThrow();
  });

  it("rejects non-string array elements", () => {
    expect(() =>
      PutAppPermissionsRequestSchema.parse({ namespaces: ["fs", 42] }),
    ).toThrow();
  });

  it("rejects a non-array namespaces field", () => {
    expect(() =>
      PutAppPermissionsRequestSchema.parse({ namespaces: "fs" }),
    ).toThrow();
  });

  it("rejects extra unknown fields (strict)", () => {
    expect(() =>
      PutAppPermissionsRequestSchema.parse({
        namespaces: ["fs"],
        extra: true,
      }),
    ).toThrow();
  });
});
