/**
 * Unit tests for hardware product catalog and lookup helpers.
 * Validates SKU mappings, slug index lookups, and product specification data.
 */
import { describe, expect, it } from "vitest";
import {
  findBySku,
  findBySlug,
  HARDWARE_PRODUCTS,
  HARDWARE_SKUS,
} from "../index.ts";

describe("hardware-catalog", () => {
  describe("HARDWARE_PRODUCTS and HARDWARE_SKUS", () => {
    it("registers all 8 hardware catalog products", () => {
      expect(HARDWARE_PRODUCTS).toHaveLength(8);
      expect(HARDWARE_SKUS).toHaveLength(8);
      expect(HARDWARE_SKUS).toContain("elizaos-usb");
      expect(HARDWARE_SKUS).toContain("elizaos-phone");
      expect(HARDWARE_SKUS).toContain("elizaos-box");
      expect(HARDWARE_SKUS).toContain("elizaos-mini-pc");
    });

    it("has required price and marketing metadata on every product", () => {
      for (const product of HARDWARE_PRODUCTS) {
        expect(product.priceUsd).toBeGreaterThan(0);
        expect(product.colors.length).toBeGreaterThan(0);
        expect(product.stripeName.length).toBeGreaterThan(0);
        expect(product.stripeDescription.length).toBeGreaterThan(0);
      }
    });
  });

  describe("findBySku", () => {
    it("returns product when matching SKU exists", () => {
      const product = findBySku("elizaos-phone");
      expect(product).toBeDefined();
      expect(product?.name).toBe("ElizaOS Phone");
      expect(product?.kind).toBe("phone");
    });

    it("returns undefined for unknown SKU", () => {
      expect(findBySku("non-existent-sku")).toBeUndefined();
    });
  });

  describe("findBySlug", () => {
    it("returns product when matching slug exists", () => {
      const product = findBySlug("usb");
      expect(product).toBeDefined();
      expect(product?.sku).toBe("elizaos-usb");
    });

    it("returns undefined for unknown slug", () => {
      expect(findBySlug("unknown-slug")).toBeUndefined();
    });
  });
});
