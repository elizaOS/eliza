/** Verifies invalid entity pagination is rejected before the SQL database boundary is entered. */
import type { UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { BaseDrizzleAdapter } from "../base";

describe("BaseDrizzleAdapter.queryEntities pagination", () => {
  it.each([
    ["offset", -1],
    ["offset", 1.5],
    ["limit", Number.NaN],
    ["limit", Number.POSITIVE_INFINITY],
  ] as const)("rejects invalid %s value %s before opening the database", async (field, value) => {
    const withDatabase = vi.fn();
    const adapter = Object.create(BaseDrizzleAdapter.prototype) as BaseDrizzleAdapter;
    Object.defineProperty(adapter, "withDatabase", { value: withDatabase });

    await expect(
      adapter.queryEntities({
        entityIds: ["00000000-0000-0000-0000-000000000001" as UUID],
        [field]: value,
      })
    ).rejects.toThrow(`queryEntities ${field} must be a non-negative safe integer`);
    expect(withDatabase).not.toHaveBeenCalled();
  });
});
