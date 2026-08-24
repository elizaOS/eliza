/**
 * Unit tests for react runtime stubs: validates installer function.
 */
import { describe, expect, it } from "vitest";
import { registerScenarioRuntimeReactStubs } from "./react-runtime-stubs.ts";

describe("react-runtime-stubs", () => {
  it("exports registerScenarioRuntimeReactStubs function and executes safely", () => {
    expect(typeof registerScenarioRuntimeReactStubs).toBe("function");
    expect(() => registerScenarioRuntimeReactStubs()).not.toThrow();
  });
});
