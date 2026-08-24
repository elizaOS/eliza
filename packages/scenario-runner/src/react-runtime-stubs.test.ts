/**
 * Unit tests for react runtime stubs: validates registerScenarioRuntimeReactStubs.
 */
import { describe, expect, it } from "vitest";
import { registerScenarioRuntimeReactStubs } from "./react-runtime-stubs.ts";

describe("react-runtime-stubs", () => {
  it("registers react stubs without throwing in test environment", () => {
    expect(() => registerScenarioRuntimeReactStubs()).not.toThrow();
  });
});
