/** Exercises runtime target behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
import {
  activeServerKindToFirstRunRuntimeTarget,
  isElizaCloudFirstRunTarget,
} from "./runtime-target";

/**
 * First-run runtime-target mapping. `activeServerKindToFirstRunRuntimeTarget`
 * maps the active server kind onto the first-run target the onboarding flow
 * persists; the non-obvious `cloud → elizacloud` rename is exactly the kind of
 * mapping a regression silently flips. `isElizaCloudFirstRunTarget` is the
 * predicate gating cloud-only onboarding. Both pure, zero deps, untested.
 */
describe("activeServerKindToFirstRunRuntimeTarget", () => {
  it("maps each server kind to its first-run target", () => {
    expect(activeServerKindToFirstRunRuntimeTarget("local")).toBe("local");
    expect(activeServerKindToFirstRunRuntimeTarget("remote")).toBe("remote");
    expect(activeServerKindToFirstRunRuntimeTarget("cloud")).toBe("elizacloud");
  });
});

describe("isElizaCloudFirstRunTarget", () => {
  it("is true only for the elizacloud targets", () => {
    expect(isElizaCloudFirstRunTarget("elizacloud")).toBe(true);
    expect(isElizaCloudFirstRunTarget("elizacloud-hybrid")).toBe(true);
    expect(isElizaCloudFirstRunTarget("local")).toBe(false);
    expect(isElizaCloudFirstRunTarget("remote")).toBe(false);
    expect(isElizaCloudFirstRunTarget("")).toBe(false);
  });
});
