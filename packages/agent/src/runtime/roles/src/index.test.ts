/**
 * Verifies that hosts can assign the ROLE action to exactly one capability
 * plugin without weakening the standalone roles plugin.
 */
import { describe, expect, it } from "vitest";
import { createRolesPlugin } from "./index.ts";

describe("createRolesPlugin", () => {
  it("includes ROLE by default for standalone runtimes", () => {
    expect(createRolesPlugin().actions?.map((action) => action.name)).toEqual([
      "ROLE",
    ]);
  });

  it("omits ROLE when the host's extended core bundle owns it", () => {
    expect(createRolesPlugin({ includeRoleAction: false }).actions).toEqual([]);
  });
});
