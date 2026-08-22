/** Verifies hosted browser sessions remain isolated to their creating Cloud user. */

import { describe, expect, test } from "bun:test";
import { isHostedBrowserSessionOwner } from "./browser-session-ownership";

describe("hosted browser session ownership", () => {
  const access = { organizationId: "org-1", userId: "user-1" };

  test("accepts the exact user and organization", () => {
    expect(
      isHostedBrowserSessionOwner(access, {
        organizationId: "org-1",
        userId: "user-1",
      }),
    ).toBe(true);
  });

  test("rejects a different user in the same organization", () => {
    expect(
      isHostedBrowserSessionOwner(access, {
        organizationId: "org-1",
        userId: "user-2",
      }),
    ).toBe(false);
  });

  test("preserves legacy organization-owned sessions", () => {
    expect(
      isHostedBrowserSessionOwner(
        { organizationId: "org-1", userId: null },
        { organizationId: "org-1", userId: "user-2" },
      ),
    ).toBe(true);
  });
});
