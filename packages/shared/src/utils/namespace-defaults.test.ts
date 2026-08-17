/**
 * Unit tests for ensureNamespaceDefaults in packages/shared/src/utils/namespace-defaults.ts.
 * Exercises default namespace assignment, whitespace trimming of custom namespaces,
 * empty/whitespace fallbacks to "eliza", and non-object env handling.
 */
import { describe, expect, it } from "vitest";
import { ensureNamespaceDefaults } from "./namespace-defaults.js";

describe("ensureNamespaceDefaults", () => {
  it("sets default 'eliza' namespace when ELIZA_NAMESPACE is undefined", () => {
    const env: { ELIZA_NAMESPACE?: string } = {};
    ensureNamespaceDefaults(env);
    expect(env.ELIZA_NAMESPACE).toBe("eliza");
  });

  it("sets default 'eliza' namespace when ELIZA_NAMESPACE is empty string", () => {
    const env = { ELIZA_NAMESPACE: "" };
    ensureNamespaceDefaults(env);
    expect(env.ELIZA_NAMESPACE).toBe("eliza");
  });

  it("sets default 'eliza' namespace when ELIZA_NAMESPACE is whitespace-only", () => {
    const env = { ELIZA_NAMESPACE: "   \t\n  " };
    ensureNamespaceDefaults(env);
    expect(env.ELIZA_NAMESPACE).toBe("eliza");
  });

  it("trims and preserves custom namespace values", () => {
    const env = { ELIZA_NAMESPACE: "  milady  " };
    ensureNamespaceDefaults(env);
    expect(env.ELIZA_NAMESPACE).toBe("milady");
  });

  it("preserves already clean custom namespace values", () => {
    const env = { ELIZA_NAMESPACE: "custom-agent" };
    ensureNamespaceDefaults(env);
    expect(env.ELIZA_NAMESPACE).toBe("custom-agent");
  });

  it("safely handles null or non-object env arguments", () => {
    expect(() =>
      ensureNamespaceDefaults(null as unknown as undefined),
    ).not.toThrow();
    expect(() => ensureNamespaceDefaults(undefined)).not.toThrow();
    expect(() =>
      ensureNamespaceDefaults("string" as unknown as undefined),
    ).not.toThrow();
  });
});
