import { describe, expect, it } from "vitest";
import { elizaOSCloudPlugin } from "../index.js";

describe("ElizaOS Cloud Plugin", () => {
  describe("Plugin metadata", () => {
    it("should have correct name", () => {
      expect(elizaOSCloudPlugin.name).toBe("elizaOSCloud");
    });

    it("should have description", () => {
      expect(elizaOSCloudPlugin.description).toBeDefined();
      expect(elizaOSCloudPlugin.description).toContain("ElizaOS Cloud");
    });

    it("should have init function", () => {
      expect(elizaOSCloudPlugin.init).toBeDefined();
      expect(typeof elizaOSCloudPlugin.init).toBe("function");
    });

    it("should have config defined", () => {
      expect(elizaOSCloudPlugin.config).toBeDefined();
    });
  });

  describe("Config properties", () => {
    it("should have ELIZAOS_CLOUD_API_KEY config", () => {
      expect("ELIZAOS_CLOUD_API_KEY" in (elizaOSCloudPlugin.config ?? {})).toBe(
        true,
      );
    });

    it("should have ELIZAOS_CLOUD_BASE_URL config", () => {
      expect(
        "ELIZAOS_CLOUD_BASE_URL" in (elizaOSCloudPlugin.config ?? {}),
      ).toBe(true);
    });

    it("should have model config options", () => {
      const config = elizaOSCloudPlugin.config ?? {};
      expect("ELIZAOS_CLOUD_SMALL_MODEL" in config).toBe(true);
      expect("ELIZAOS_CLOUD_LARGE_MODEL" in config).toBe(true);
      expect("ELIZAOS_CLOUD_EMBEDDING_MODEL" in config).toBe(true);
    });
  });

  describe("Model handlers", () => {
    it("should have models object defined", () => {
      expect(elizaOSCloudPlugin.models).toBeDefined();
    });

    it("should have TEXT_EMBEDDING model handler", () => {
      expect(elizaOSCloudPlugin.models?.TEXT_EMBEDDING).toBeDefined();
      expect(typeof elizaOSCloudPlugin.models?.TEXT_EMBEDDING).toBe("function");
    });

    it("should have TEXT_SMALL model handler", () => {
      expect(elizaOSCloudPlugin.models?.TEXT_SMALL).toBeDefined();
      expect(typeof elizaOSCloudPlugin.models?.TEXT_SMALL).toBe("function");
    });

    it("should have TEXT_LARGE model handler", () => {
      expect(elizaOSCloudPlugin.models?.TEXT_LARGE).toBeDefined();
      expect(typeof elizaOSCloudPlugin.models?.TEXT_LARGE).toBe("function");
    });

    it("should have IMAGE model handler", () => {
      expect(elizaOSCloudPlugin.models?.IMAGE).toBeDefined();
      expect(typeof elizaOSCloudPlugin.models?.IMAGE).toBe("function");
    });

    it("should have IMAGE_DESCRIPTION model handler", () => {
      expect(elizaOSCloudPlugin.models?.IMAGE_DESCRIPTION).toBeDefined();
      expect(typeof elizaOSCloudPlugin.models?.IMAGE_DESCRIPTION).toBe(
        "function",
      );
    });

    it("should have OBJECT_SMALL model handler", () => {
      expect(elizaOSCloudPlugin.models?.OBJECT_SMALL).toBeDefined();
      expect(typeof elizaOSCloudPlugin.models?.OBJECT_SMALL).toBe("function");
    });

    it("should have OBJECT_LARGE model handler", () => {
      expect(elizaOSCloudPlugin.models?.OBJECT_LARGE).toBeDefined();
      expect(typeof elizaOSCloudPlugin.models?.OBJECT_LARGE).toBe("function");
    });
  });

  describe("Plugin tests", () => {
    it("should have inline tests defined", () => {
      expect(elizaOSCloudPlugin.tests).toBeDefined();
      expect(Array.isArray(elizaOSCloudPlugin.tests)).toBe(true);
    });

    it("should have ELIZAOS_CLOUD_plugin_tests test suite", () => {
      const testSuite = elizaOSCloudPlugin.tests?.find(
        (t) => t.name === "ELIZAOS_CLOUD_plugin_tests",
      );
      expect(testSuite).toBeDefined();
    });
  });
});
