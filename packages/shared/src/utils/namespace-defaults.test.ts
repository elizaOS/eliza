/**
 * Unit tests for ensureNamespaceDefaults in packages/shared/src/utils/namespace-defaults.ts.
 * Exercises default assignment, whitespace handling, custom namespace preservation,
 * non-string property handling, and undefined environment objects.
 */
import { describe, expect, it } from "vitest";
import { ensureNamespaceDefaults } from "./namespace-defaults.js";

describe("namespace defaults utilities", () => {
  describe("ensureNamespaceDefaults", () => {
    it("sets default namespace to eliza when unset", () => {
      const mockEnv: { ELIZA_NAMESPACE?: string } = {};
      ensureNamespaceDefaults(mockEnv);
      expect(mockEnv.ELIZA_NAMESPACE).toBe("eliza");
    });

    it("replaces whitespace-only or empty namespace with eliza default", () => {
      const emptyEnv: { ELIZA_NAMESPACE?: string } = { ELIZA_NAMESPACE: "" };
      ensureNamespaceDefaults(emptyEnv);
      expect(emptyEnv.ELIZA_NAMESPACE).toBe("eliza");

      const whitespaceEnv: { ELIZA_NAMESPACE?: string } = {
        ELIZA_NAMESPACE: "   \t\n  ",
      };
      ensureNamespaceDefaults(whitespaceEnv);
      expect(whitespaceEnv.ELIZA_NAMESPACE).toBe("eliza");
    });

    it("preserves custom configured namespaces", () => {
      const customEnv: { ELIZA_NAMESPACE?: string } = {
        ELIZA_NAMESPACE: "milady",
      };
      ensureNamespaceDefaults(customEnv);
      expect(customEnv.ELIZA_NAMESPACE).toBe("milady");

      const scopedEnv: { ELIZA_NAMESPACE?: string } = {
        ELIZA_NAMESPACE: "org-agent-namespace",
      };
      ensureNamespaceDefaults(scopedEnv);
      expect(scopedEnv.ELIZA_NAMESPACE).toBe("org-agent-namespace");
    });

    it("handles non-string properties without throwing", () => {
      const nonStringEnv = {
        ELIZA_NAMESPACE: 12345 as unknown as string,
      };
      expect(() => ensureNamespaceDefaults(nonStringEnv)).not.toThrow();
      expect(nonStringEnv.ELIZA_NAMESPACE).toBe("eliza");
    });

    it("safely handles undefined env parameter", () => {
      expect(() => ensureNamespaceDefaults(undefined)).not.toThrow();
    });
  });
});
