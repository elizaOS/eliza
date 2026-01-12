import { beforeEach, describe, expect, it } from "vitest";
import { SimpleHNSW } from "../hnsw";

describe("SimpleHNSW", () => {
  let hnsw: SimpleHNSW;

  beforeEach(async () => {
    hnsw = new SimpleHNSW();
    await hnsw.init(3);
  });

  describe("initialization", () => {
    it("should initialize with given dimension", async () => {
      expect(hnsw.size()).toBe(0);
    });
  });

  describe("add and search", () => {
    it("should add vectors", async () => {
      await hnsw.add("v1", [1.0, 0.0, 0.0]);
      await hnsw.add("v2", [0.0, 1.0, 0.0]);
      await hnsw.add("v3", [0.0, 0.0, 1.0]);

      expect(hnsw.size()).toBe(3);
    });

    it("should find exact match", async () => {
      await hnsw.add("v1", [1.0, 0.0, 0.0]);

      const results = await hnsw.search([1.0, 0.0, 0.0], 1, 0.99);
      expect(results.length).toBe(1);
      expect(results[0].id).toBe("v1");
      expect(results[0].similarity).toBeCloseTo(1.0, 5);
    });

    it("should find nearest neighbors", async () => {
      await hnsw.add("v1", [1.0, 0.0, 0.0]);
      await hnsw.add("v2", [0.9, 0.1, 0.0]); // Similar to v1
      await hnsw.add("v3", [0.0, 1.0, 0.0]); // Orthogonal

      const results = await hnsw.search([1.0, 0.0, 0.0], 2, 0.5);

      expect(results.length).toBe(2);
      expect(results[0].id).toBe("v1");
      expect(results[1].id).toBe("v2");
    });

    it("should respect threshold", async () => {
      await hnsw.add("v1", [1.0, 0.0, 0.0]);
      await hnsw.add("v2", [0.0, 1.0, 0.0]); // Orthogonal (similarity ~0)

      const results = await hnsw.search([1.0, 0.0, 0.0], 2, 0.9);

      // Only v1 should pass the high threshold
      expect(results.length).toBe(1);
      expect(results[0].id).toBe("v1");
    });

    it("should handle normalized vectors", async () => {
      // Normalized vectors
      const sqrt2 = Math.sqrt(2);
      await hnsw.add("v1", [1 / sqrt2, 1 / sqrt2, 0.0]);
      await hnsw.add("v2", [1.0, 0.0, 0.0]);

      const results = await hnsw.search([1 / sqrt2, 1 / sqrt2, 0.0], 1, 0.9);
      expect(results[0].id).toBe("v1");
    });
  });

  describe("remove", () => {
    it("should remove vectors", async () => {
      await hnsw.add("v1", [1.0, 0.0, 0.0]);
      await hnsw.add("v2", [0.0, 1.0, 0.0]);

      await hnsw.remove("v1");

      expect(hnsw.size()).toBe(1);

      const results = await hnsw.search([1.0, 0.0, 0.0], 2, 0.0);
      expect(results.every((r) => r.id !== "v1")).toBe(true);
    });
  });

  describe("serialization", () => {
    it("should serialize and deserialize", async () => {
      await hnsw.add("v1", [1.0, 0.0, 0.0]);
      await hnsw.add("v2", [0.0, 1.0, 0.0]);

      const serialized = hnsw.getIndex();

      const hnsw2 = new SimpleHNSW(
        async () => {},
        async () => serialized
      );
      await hnsw2.init(3);

      expect(hnsw2.size()).toBe(2);

      // Search should work on deserialized index
      const results = await hnsw2.search([1.0, 0.0, 0.0], 1, 0.9);
      expect(results[0].id).toBe("v1");
    });
  });

  describe("edge cases", () => {
    it("should handle empty index search", async () => {
      const results = await hnsw.search([1.0, 0.0, 0.0], 10, 0.0);
      expect(results.length).toBe(0);
    });

    it("should handle single vector", async () => {
      await hnsw.add("v1", [1.0, 0.0, 0.0]);

      const results = await hnsw.search([1.0, 0.0, 0.0], 10, 0.0);
      expect(results.length).toBe(1);
    });

    it("should update existing vector", async () => {
      await hnsw.add("v1", [1.0, 0.0, 0.0]);
      await hnsw.add("v1", [0.0, 1.0, 0.0]);

      expect(hnsw.size()).toBe(1);

      const results = await hnsw.search([0.0, 1.0, 0.0], 1, 0.9);
      expect(results[0].id).toBe("v1");
    });

    it("should throw on dimension mismatch", async () => {
      await expect(
        hnsw.add("v1", [1.0, 0.0]) // 2D instead of 3D
      ).rejects.toThrow("dimension mismatch");
    });
  });

  describe("larger scale", () => {
    it("should handle multiple vectors", async () => {
      // Add 100 random vectors
      for (let i = 0; i < 100; i++) {
        const vec = [Math.random(), Math.random(), Math.random()];
        // Normalize
        const norm = Math.sqrt(vec[0] ** 2 + vec[1] ** 2 + vec[2] ** 2);
        await hnsw.add(
          `v${i}`,
          vec.map((v) => v / norm)
        );
      }

      expect(hnsw.size()).toBe(100);

      const results = await hnsw.search([1.0, 0.0, 0.0], 5, 0.0);
      expect(results.length).toBe(5);
    });
  });
});
