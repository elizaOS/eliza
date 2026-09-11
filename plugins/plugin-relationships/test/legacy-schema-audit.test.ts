/**
 * Tests the read-only retirement guard for the unused relationships schema.
 * The harness executes the real inventory contract through a deterministic SQL
 * boundary so absent, empty, populated, and malformed results stay distinct.
 */
import { describe, expect, it } from "vitest";
import { inventoryLegacyRelationshipsSchema } from "../src/services/legacy-schema-audit.js";

describe("inventoryLegacyRelationshipsSchema", () => {
  it("treats an absent or empty legacy schema as safe", async () => {
    await expect(
      inventoryLegacyRelationshipsSchema(async () => [
        { entities: false, relationships: false },
      ]),
    ).resolves.toEqual({ entities: 0, relationships: 0 });
  });

  it("returns every legacy row count for an operator-owned import decision", async () => {
    const results = [
      [{ entities: true, relationships: "true" }],
      [{ count: "12" }],
      [{ count: "7" }],
    ];
    await expect(
      inventoryLegacyRelationshipsSchema(async () => results.shift() ?? []),
    ).resolves.toEqual({ entities: 12, relationships: 7 });
  });

  it("fails closed when the database returns an unreadable count", async () => {
    const results = [
      [{ entities: true, relationships: false }],
      [{ count: "many" }],
    ];
    await expect(
      inventoryLegacyRelationshipsSchema(async () => results.shift() ?? []),
    ).rejects.toMatchObject({
      code: "RELATIONSHIPS_LEGACY_SCHEMA_INVENTORY_INVALID",
    });
  });

  it.each([
    ["no presence row", []],
    [
      "multiple presence rows",
      [
        { entities: false, relationships: false },
        { entities: false, relationships: false },
      ],
    ],
    ["a missing presence field", [{ entities: false }]],
    ["an unreadable presence field", [{ entities: false, relationships: 0 }]],
  ])(
    "fails closed when the presence query returns %s",
    async (_label, presence) => {
      await expect(
        inventoryLegacyRelationshipsSchema(async () => presence),
      ).rejects.toMatchObject({
        code: "RELATIONSHIPS_LEGACY_SCHEMA_INVENTORY_INVALID",
      });
    },
  );

  it.each([
    ["no count row", []],
    ["multiple count rows", [{ count: "0" }, { count: "0" }]],
    ["a missing count field", [{}]],
    ["an empty count", [{ count: "" }]],
  ])(
    "fails closed when a legacy count query returns %s",
    async (_label, countRows) => {
      const results = [[{ entities: true, relationships: false }], countRows];
      await expect(
        inventoryLegacyRelationshipsSchema(async () => results.shift() ?? []),
      ).rejects.toMatchObject({
        code: "RELATIONSHIPS_LEGACY_SCHEMA_INVENTORY_INVALID",
      });
    },
  );
});
