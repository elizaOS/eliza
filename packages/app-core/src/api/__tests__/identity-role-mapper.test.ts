import { describe, expect, it } from "vitest";
import { roleForIdentityKind } from "../auth.js";

/**
 * #12087 Item 15: `roleForIdentityKind` is the single identity-kind → canonical
 * role mapper. Both the /api/auth/me session-route response and the server-side
 * route-role resolution (resolveSessionRole) derive the caller's role from it,
 * so the two cannot drift.
 */
describe("roleForIdentityKind (#12087 Item 15)", () => {
  it("maps owner → OWNER and machine → USER", () => {
    expect(roleForIdentityKind("owner")).toBe("OWNER");
    expect(roleForIdentityKind("machine")).toBe("USER");
  });

  it("fails closed to NONE for no identity", () => {
    expect(roleForIdentityKind(null)).toBe("NONE");
    expect(roleForIdentityKind(undefined)).toBe("NONE");
  });
});
