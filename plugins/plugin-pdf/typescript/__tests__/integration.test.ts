import { describe, expect, it } from "vitest";

describe("PDF Plugin Integration Tests", () => {
  describe("Plugin Structure", () => {
    it("should export pdfPlugin", async () => {
      const { pdfPlugin } = await import("../index");
      expect(pdfPlugin).toBeDefined();
      expect(pdfPlugin.name).toBe("pdf");
    });

    it("should have correct description", async () => {
      const { pdfPlugin } = await import("../index");
      expect(pdfPlugin.description).toContain("PDF");
    });

    it("should have services defined", async () => {
      const { pdfPlugin } = await import("../index");
      expect(pdfPlugin.services).toBeDefined();
      expect(Array.isArray(pdfPlugin.services)).toBe(true);
      expect(pdfPlugin.services?.length).toBeGreaterThan(0);
    });

    it("should have empty actions array", async () => {
      const { pdfPlugin } = await import("../index");
      expect(pdfPlugin.actions).toEqual([]);
    });
  });

  describe("PdfService", () => {
    it("should export PdfService", async () => {
      const { PdfService } = await import("../services/pdf");
      expect(PdfService).toBeDefined();
    });

    it("should be a valid service class", async () => {
      const { PdfService } = await import("../services/pdf");
      expect(PdfService.serviceType.toLowerCase()).toBe("pdf");
    });
  });

  describe("Types", () => {
    it("should export all types", async () => {
      const types = await import("../types");
      expect(types).toBeDefined();
    });
  });
});
