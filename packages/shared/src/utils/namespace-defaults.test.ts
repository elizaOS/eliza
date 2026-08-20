/**
 * Unit tests for app namespace default initialization in packages/shared/src/utils/namespace-defaults.ts.
 * Exercises deterministic default namespace assignment for unset, empty, and whitespace-only inputs,
 * custom namespace preservation, and safe execution when environment variables are omitted.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureNamespaceDefaults } from "./namespace-defaults.js";

describe("namespace defaults utilities", () => {
  const originalNamespace = process.env.ELIZA_NAMESPACE;

  beforeEach(() => {
    delete process.env.ELIZA_NAMESPACE;
  });

  afterEach(() => {
    if (originalNamespace === undefined) {
      delete process.env.ELIZA_NAMESPACE;
    } else {
      process.env.ELIZA_NAMESPACE = originalNamespace;
    }
  });

  describe("ensureNamespaceDefaults", () => {
    it("sets default namespace to 'eliza' when ELIZA_NAMESPACE is unset", () => {
      const env: { ELIZA_NAMESPACE?: string } = {};
      ensureNamespaceDefaults(env);
      expect(env.ELIZA_NAMESPACE).toBe("eliza");
    });

    it("replaces empty string namespace with 'eliza' default", () => {
      const env = { ELIZA_NAMESPACE: "" };
      ensureNamespaceDefaults(env);
      expect(env.ELIZA_NAMESPACE).toBe("eliza");
    });

    it("replaces whitespace-only namespace with 'eliza' default", () => {
      const env = { ELIZA_NAMESPACE: "   " };
      ensureNamespaceDefaults(env);
      expect(env.ELIZA_NAMESPACE).toBe("eliza");
    });

    it("preserves custom configured namespaces", () => {
      const env = { ELIZA_NAMESPACE: "milady" };
      ensureNamespaceDefaults(env);
      expect(env.ELIZA_NAMESPACE).toBe("milady");
    });

    it("applies the default to the global environment when env is omitted", () => {
      ensureNamespaceDefaults();
      expect(process.env.ELIZA_NAMESPACE).toBe("eliza");
    });
  });
});
