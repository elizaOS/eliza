/**
 * Verifies the public `EphemeralHNSW` lifecycle against its real in-memory
 * node map, including replacement inserts that must not increase index size.
 */
import { describe, expect, it } from "vitest";
import { EphemeralHNSW } from "./index";

describe("EphemeralHNSW public lifecycle", () => {
  it("reports size across initialization, replacement, removal, and clear", async () => {
    const index = new EphemeralHNSW();

    expect(index.size()).toBe(0);
    await index.init(3);
    expect(index.size()).toBe(0);

    await index.add("first", [1, 0, 0]);
    expect(index.size()).toBe(1);

    await index.add("first", [0, 1, 0]);
    expect(index.size()).toBe(1);
    await expect(index.searchExact([0, 1, 0], 1, 0)).resolves.toEqual([
      { id: "first", distance: 0, similarity: 1 },
    ]);

    await index.add("second", [0, 0, 1]);
    expect(index.size()).toBe(2);

    await index.remove("first");
    expect(index.size()).toBe(1);

    await index.clear();
    expect(index.size()).toBe(0);
  });
});
