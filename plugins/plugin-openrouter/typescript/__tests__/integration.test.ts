import { describe, expect, it } from "vitest";

const API_KEY = process.env.OPENROUTER_API_KEY;
const skipIfNoApiKey = API_KEY ? it : it.skip;

describe("OpenRouter Plugin Integration Tests", () => {
  describe("Plugin Structure", () => {
    it("should export openrouterPlugin", async () => {
      const { openrouterPlugin } = await import("../plugin");
      expect(openrouterPlugin).toBeDefined();
      expect(openrouterPlugin.name).toBe("openrouter");
    });

    it("should have correct description", async () => {
      const { openrouterPlugin } = await import("../plugin");
      expect(openrouterPlugin.description).toContain("OpenRouter");
    });

    it("should have models defined", async () => {
      const { openrouterPlugin } = await import("../plugin");
      expect(openrouterPlugin.models).toBeDefined();
    });

    it("should have init function", async () => {
      const { openrouterPlugin } = await import("../plugin");
      expect(typeof openrouterPlugin.init).toBe("function");
    });
  });

  describe("Configuration", () => {
    it("should have all config keys", async () => {
      const { openrouterPlugin } = await import("../plugin");
      const config = openrouterPlugin.config;
      expect(config).toHaveProperty("OPENROUTER_API_KEY");
    });
  });

  describe("Model Handlers", () => {
    it("should have TEXT_SMALL handler", async () => {
      const { openrouterPlugin } = await import("../plugin");
      expect(openrouterPlugin.models?.TEXT_SMALL).toBeDefined();
    });

    it("should have TEXT_LARGE handler", async () => {
      const { openrouterPlugin } = await import("../plugin");
      expect(openrouterPlugin.models?.TEXT_LARGE).toBeDefined();
    });

    it("should have TEXT_EMBEDDING handler", async () => {
      const { openrouterPlugin } = await import("../plugin");
      expect(openrouterPlugin.models?.TEXT_EMBEDDING).toBeDefined();
    });
  });

  describe("API Tests (skip if no API key)", () => {
    skipIfNoApiKey("should be able to connect to API", async () => {
      const response = await fetch("https://openrouter.ai/api/v1/models", {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
        },
      });

      expect(response.ok).toBe(true);
    });
  });
});
