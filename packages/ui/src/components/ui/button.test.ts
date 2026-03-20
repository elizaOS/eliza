import { describe, expect, it } from "vitest";
import { buttonVariants } from "./button";

describe("buttonVariants", () => {
  describe("default variant", () => {
    it("includes bg-accent/15", () => {
      const classes = buttonVariants({ variant: "default" });
      expect(classes).toContain("bg-accent/15");
    });

    it("does not include bg-primary", () => {
      const classes = buttonVariants({ variant: "default" });
      expect(classes).not.toContain("bg-primary");
    });
  });

  describe("outline variant", () => {
    it("includes bg-card", () => {
      const classes = buttonVariants({ variant: "outline" });
      expect(classes).toContain("bg-card");
    });

    it("does not use bg-bg as a standalone class (only bg-card and bg-bg-hover)", () => {
      const classes = buttonVariants({ variant: "outline" });
      // bg-bg (standalone) should not appear — the outline variant uses bg-card
      // for background. bg-bg-hover is allowed (for hover state).
      expect(classes).not.toMatch(/(?:^| )bg-bg(?:$| )/);
    });
  });

  describe("ghost variant", () => {
    it("hover includes hover:text-txt", () => {
      const classes = buttonVariants({ variant: "ghost" });
      expect(classes).toContain("hover:text-txt");
    });

    it("does not include hover:text-accent-fg", () => {
      const classes = buttonVariants({ variant: "ghost" });
      expect(classes).not.toContain("hover:text-accent-fg");
    });
  });

  describe("secondary variant", () => {
    it("includes bg-bg-accent", () => {
      const classes = buttonVariants({ variant: "secondary" });
      expect(classes).toContain("bg-bg-accent");
    });
  });

  describe("destructive variant", () => {
    it("includes bg-destructive", () => {
      const classes = buttonVariants({ variant: "destructive" });
      expect(classes).toContain("bg-destructive");
    });
  });

  describe("default variant is applied when no variant specified", () => {
    it("falls back to default variant classes", () => {
      const withDefault = buttonVariants({ variant: "default" });
      const withoutVariant = buttonVariants({});
      expect(withoutVariant).toContain("bg-accent/15");
      expect(withoutVariant).toBe(withDefault);
    });
  });
});
