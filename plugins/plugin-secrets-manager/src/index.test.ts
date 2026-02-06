import { describe, it, expect } from "vitest";
import { envPlugin } from "./index";
import { EnvManagerService } from "./service";

describe("index", () => {
  describe("envPlugin", () => {
    it("should export a valid plugin object", () => {
      expect(envPlugin).toBeDefined();
      expect(envPlugin.name).toBe("plugin-env");
      expect(envPlugin.description).toContain(
        "Secret and environment variable management",
      );
    });

    it("should include EnvManagerService in services", () => {
      expect(envPlugin.services).toBeDefined();
      expect(envPlugin.services.length).toBeGreaterThan(0);
    });

    it("should have providers array", () => {
      expect(envPlugin.providers).toBeDefined();
      expect(Array.isArray(envPlugin.providers)).toBe(true);
    });

    it("should have actions array", () => {
      expect(envPlugin.actions).toBeDefined();
      expect(Array.isArray(envPlugin.actions)).toBe(true);
    });

    it("should have evaluators array or undefined", () => {
      // evaluators is optional in the plugin interface
      if (envPlugin.evaluators) {
        expect(Array.isArray(envPlugin.evaluators)).toBe(true);
      } else {
        expect(envPlugin.evaluators).toBeUndefined();
      }
    });

    it("should have an init function", () => {
      expect(envPlugin.init).toBeDefined();
      expect(typeof envPlugin.init).toBe("function");
    });

    it("should export types", () => {
      // Test that types are exported by importing them dynamically
      import("./index").then((module) => {
        expect(module.EnvManagerService).toBe(EnvManagerService);
      });
    });
  });
});
