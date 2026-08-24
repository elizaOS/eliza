/**
 * Behavior tests for the synthetic-environment lease namespace contract —
 * the canonical namespace check shared by lease and subprocess authorities.
 *
 * `isSyntheticEnvironmentNamespace` gates process namespaces, so the bounds
 * are fail-closed: empty, oversized, non-trimmed, and control-character
 * namespaces must all be rejected, and the constants must match the
 * subprocess control envelope's namespace bound.
 */
import { describe, expect, it } from "vitest";
import {
  isSyntheticEnvironmentNamespace,
  SYNTHETIC_ENVIRONMENT_LEASE_VERSION,
  SYNTHETIC_ENVIRONMENT_NAMESPACE_MAX_LENGTH,
} from "./synthetic-environment-lease.ts";

describe("isSyntheticEnvironmentNamespace", () => {
  it("accepts a canonical namespace", () => {
    expect(isSyntheticEnvironmentNamespace("sim-42")).toBe(true);
    expect(isSyntheticEnvironmentNamespace("a".repeat(512))).toBe(true);
  });

  it("rejects non-string values", () => {
    expect(isSyntheticEnvironmentNamespace(undefined)).toBe(false);
    expect(isSyntheticEnvironmentNamespace(null)).toBe(false);
    expect(isSyntheticEnvironmentNamespace(42)).toBe(false);
    expect(isSyntheticEnvironmentNamespace({})).toBe(false);
    expect(isSyntheticEnvironmentNamespace(["x"])).toBe(false);
  });

  it("rejects empty and whitespace-only namespaces", () => {
    expect(isSyntheticEnvironmentNamespace("")).toBe(false);
    expect(isSyntheticEnvironmentNamespace("   ")).toBe(false);
    expect(isSyntheticEnvironmentNamespace("\t")).toBe(false);
  });

  it("rejects namespaces that exceed the 512-char bound", () => {
    expect(isSyntheticEnvironmentNamespace("a".repeat(513))).toBe(false);
    expect(
      isSyntheticEnvironmentNamespace(
        `a${"b".repeat(SYNTHETIC_ENVIRONMENT_NAMESPACE_MAX_LENGTH)}`,
      ),
    ).toBe(false);
  });

  it("rejects namespaces with leading or trailing whitespace", () => {
    expect(isSyntheticEnvironmentNamespace(" sim-42")).toBe(false);
    expect(isSyntheticEnvironmentNamespace("sim-42 ")).toBe(false);
    expect(isSyntheticEnvironmentNamespace(" sim-42 ")).toBe(false);
  });

  it("rejects namespaces containing control characters", () => {
    expect(isSyntheticEnvironmentNamespace("sim\u0000x")).toBe(false);
    expect(isSyntheticEnvironmentNamespace("sim\u001fx")).toBe(false);
    expect(isSyntheticEnvironmentNamespace("sim\u007fx")).toBe(false);
    expect(isSyntheticEnvironmentNamespace("sim\n42")).toBe(false);
  });

  it("accepts namespaces with interior whitespace and punctuation", () => {
    expect(isSyntheticEnvironmentNamespace("sim-42.a/b_c")).toBe(true);
    expect(isSyntheticEnvironmentNamespace("sim 42")).toBe(true);
  });

  it("pins the version and bound constants", () => {
    expect(SYNTHETIC_ENVIRONMENT_LEASE_VERSION).toBe(1);
    expect(SYNTHETIC_ENVIRONMENT_NAMESPACE_MAX_LENGTH).toBe(512);
  });
});
