/**
 * Compile-time compatibility coverage for the public vector-storage contract.
 * A third-party implementation of the documented approximate-index surface
 * must remain valid without adopting EphemeralHNSW-specific exact search.
 */
import { describe, expect, it } from "vitest";
import type { IVectorStorage } from "./types";

const thirdPartyVectorStorage = {
  async init(_dimension: number): Promise<void> {},
  async add(_id: string, _vector: number[]): Promise<void> {},
  async remove(_id: string): Promise<void> {},
  async search(_query: number[], _k: number, _threshold?: number) {
    return [];
  },
  async clear(): Promise<void> {},
} satisfies IVectorStorage;

describe("IVectorStorage public compatibility", () => {
  it("accepts an existing approximate-only third-party implementation", async () => {
    await expect(thirdPartyVectorStorage.search([1, 0], 1)).resolves.toEqual([]);
  });
});
