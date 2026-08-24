/**
 * Unit tests for canonical hardware product catalog.
 * Validates product entries, SKU definitions, and findBySku / findBySlug lookups.
 */
import { describe, expect, it } from "vitest";
import {
  findBySku,
  findBySlug,
  HARDWARE_PRODUCTS,
  HARDWARE_SKUS,
} from "../index.ts";

describe("hardware-catalog", () => {
  describe("HARDWARE_PRODUCTS catalog", () => {
    it("contains defined hardware devices with valid pricing and kinds", () => {
      expect(HARDWARE_PRODUCTS.length).toBeGreaterThan(0);
      for (const product of HARDWARE_PRODUCTS) {
        expect(product.slug).toBeTruthy();
        expect(product.sku).toBeTruthy();
        expect(product.name).toBeTruthy();
        expect(product.priceUsd).toBeGreaterThan(0);
        expect(["phone", "box", "usb", "chibi", "mini"]).toContain(
          product.kind,
        );
        expect(product.colors.length).toBeGreaterThan(0);
      }
    });

    it("matches HARDWARE_SKUS array to product catalog SKUs", () => {
      const expectedSkus = HARDWARE_PRODUCTS.map((p) => p.sku);
      expect(HARDWARE_SKUS).toEqual(expectedSkus);
    });
  });

  describe("findBySku", () => {
    it("finds existing product by exact SKU", () => {
      const product = findBySku("elizaos-usb");
      expect(product).toBeDefined();
      expect(product?.slug).toBe("usb");
      expect(product?.name).toBe("ElizaOS USB");
    });

    it("returns undefined for non-existent SKU", () => {
      expect(findBySku("non-existent-sku")).toBeUndefined();
    });
  });

  describe("findBySlug", () => {
    it("finds existing product by exact slug", () => {
      const product = findBySlug("phone");
      expect(product).toBeDefined();
      expect(product?.sku).toBe("elizaos-phone");
      expect(product?.kind).toBe("phone");
    });

    it("returns undefined for non-existent slug", () => {
      expect(findBySlug("unknown-slug")).toBeUndefined();
    });
  });
});
