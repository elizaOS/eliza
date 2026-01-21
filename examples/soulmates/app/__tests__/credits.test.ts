import { describe, expect, it } from "vitest";
import { CREDIT_PACKS, type CreditPack, getCreditPack } from "../lib/credits";

describe("CREDIT_PACKS", () => {
  describe("structure", () => {
    it("contains exactly three packs", () => {
      expect(CREDIT_PACKS).toHaveLength(3);
    });

    it("has unique IDs", () => {
      const ids = CREDIT_PACKS.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("has all required pack IDs", () => {
      const ids = CREDIT_PACKS.map((p) => p.id);
      expect(ids).toContain("starter");
      expect(ids).toContain("standard");
      expect(ids).toContain("plus");
    });
  });

  describe("starter pack", () => {
    let starter: CreditPack | undefined;

    beforeAll(() => {
      starter = CREDIT_PACKS.find((p) => p.id === "starter");
    });

    it("exists", () => {
      expect(starter).toBeDefined();
    });

    it("has correct price ($10)", () => {
      expect(starter?.amount).toBe(1000); // cents
    });

    it("has correct credits (100)", () => {
      expect(starter?.credits).toBe(100);
    });

    it("has $10 label", () => {
      expect(starter?.label).toBe("$10");
    });

    it("has non-empty description", () => {
      expect(starter?.description).toBeDefined();
      expect(starter?.description.length).toBeGreaterThan(0);
    });
  });

  describe("standard pack", () => {
    let standard: CreditPack | undefined;

    beforeAll(() => {
      standard = CREDIT_PACKS.find((p) => p.id === "standard");
    });

    it("exists", () => {
      expect(standard).toBeDefined();
    });

    it("has correct price ($25)", () => {
      expect(standard?.amount).toBe(2500); // cents
    });

    it("has correct credits (300)", () => {
      expect(standard?.credits).toBe(300);
    });

    it("has $25 label", () => {
      expect(standard?.label).toBe("$25");
    });

    it("has better value than starter (higher credits per dollar)", () => {
      const starter = CREDIT_PACKS.find((p) => p.id === "starter");
      const starterRatio = (starter?.credits ?? 0) / (starter?.amount ?? 1);
      const standardRatio = (standard?.credits ?? 0) / (standard?.amount ?? 1);
      expect(standardRatio).toBeGreaterThan(starterRatio);
    });
  });

  describe("plus pack", () => {
    let plus: CreditPack | undefined;

    beforeAll(() => {
      plus = CREDIT_PACKS.find((p) => p.id === "plus");
    });

    it("exists", () => {
      expect(plus).toBeDefined();
    });

    it("has correct price ($60)", () => {
      expect(plus?.amount).toBe(6000); // cents
    });

    it("has correct credits (800)", () => {
      expect(plus?.credits).toBe(800);
    });

    it("has $60 label", () => {
      expect(plus?.label).toBe("$60");
    });

    it("has best value (highest credits per dollar)", () => {
      const ratios = CREDIT_PACKS.map((p) => ({
        id: p.id,
        ratio: p.credits / p.amount,
      }));
      const plusRatio = ratios.find((r) => r.id === "plus")?.ratio;
      const maxRatio = Math.max(...ratios.map((r) => r.ratio));
      expect(plusRatio).toBe(maxRatio);
    });
  });

  describe("data integrity", () => {
    it("all packs have positive amounts", () => {
      for (const pack of CREDIT_PACKS) {
        expect(pack.amount).toBeGreaterThan(0);
      }
    });

    it("all packs have positive credits", () => {
      for (const pack of CREDIT_PACKS) {
        expect(pack.credits).toBeGreaterThan(0);
      }
    });

    it("all packs have non-empty labels", () => {
      for (const pack of CREDIT_PACKS) {
        expect(pack.label).toBeDefined();
        expect(pack.label.length).toBeGreaterThan(0);
      }
    });

    it("all packs have non-empty descriptions", () => {
      for (const pack of CREDIT_PACKS) {
        expect(pack.description).toBeDefined();
        expect(pack.description.length).toBeGreaterThan(0);
      }
    });

    it("amounts are in whole cents (no decimals)", () => {
      for (const pack of CREDIT_PACKS) {
        expect(Number.isInteger(pack.amount)).toBe(true);
      }
    });

    it("credits are whole numbers", () => {
      for (const pack of CREDIT_PACKS) {
        expect(Number.isInteger(pack.credits)).toBe(true);
      }
    });

    it("packs are ordered by price ascending", () => {
      for (let i = 1; i < CREDIT_PACKS.length; i++) {
        expect(CREDIT_PACKS[i].amount).toBeGreaterThan(
          CREDIT_PACKS[i - 1].amount,
        );
      }
    });
  });
});

describe("getCreditPack", () => {
  describe("valid IDs", () => {
    it("returns starter pack", () => {
      const pack = getCreditPack("starter");
      expect(pack).not.toBeNull();
      expect(pack?.id).toBe("starter");
      expect(pack?.amount).toBe(1000);
      expect(pack?.credits).toBe(100);
    });

    it("returns standard pack", () => {
      const pack = getCreditPack("standard");
      expect(pack).not.toBeNull();
      expect(pack?.id).toBe("standard");
      expect(pack?.amount).toBe(2500);
      expect(pack?.credits).toBe(300);
    });

    it("returns plus pack", () => {
      const pack = getCreditPack("plus");
      expect(pack).not.toBeNull();
      expect(pack?.id).toBe("plus");
      expect(pack?.amount).toBe(6000);
      expect(pack?.credits).toBe(800);
    });

    it("returns exact pack objects from CREDIT_PACKS", () => {
      expect(getCreditPack("starter")).toBe(CREDIT_PACKS[0]);
      expect(getCreditPack("standard")).toBe(CREDIT_PACKS[1]);
      expect(getCreditPack("plus")).toBe(CREDIT_PACKS[2]);
    });
  });

  describe("invalid IDs", () => {
    it("returns null for empty string", () => {
      expect(getCreditPack("")).toBeNull();
    });

    it("returns null for unknown ID", () => {
      expect(getCreditPack("unknown")).toBeNull();
      expect(getCreditPack("premium")).toBeNull();
      expect(getCreditPack("basic")).toBeNull();
    });

    it("returns null for case variations", () => {
      expect(getCreditPack("Starter")).toBeNull();
      expect(getCreditPack("STARTER")).toBeNull();
      expect(getCreditPack("Standard")).toBeNull();
      expect(getCreditPack("Plus")).toBeNull();
    });

    it("returns null for partial matches", () => {
      expect(getCreditPack("start")).toBeNull();
      expect(getCreditPack("stand")).toBeNull();
      expect(getCreditPack("plu")).toBeNull();
    });

    it("returns null for whitespace variations", () => {
      expect(getCreditPack(" starter")).toBeNull();
      expect(getCreditPack("starter ")).toBeNull();
      expect(getCreditPack(" starter ")).toBeNull();
    });

    it("returns null for numeric strings", () => {
      expect(getCreditPack("1")).toBeNull();
      expect(getCreditPack("0")).toBeNull();
      expect(getCreditPack("100")).toBeNull();
    });
  });
});

// Import beforeAll for the describe block scopes
import { beforeAll } from "vitest";
