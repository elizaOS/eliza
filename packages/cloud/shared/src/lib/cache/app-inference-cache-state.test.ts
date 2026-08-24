import { describe, expect, it } from "vitest";
import {
  getAppHydrationGeneration,
  getInferenceApp,
  invalidateInferenceApp,
  setInferenceApp,
} from "./app-inference-cache-state.js";

describe("app-inference-cache-state", () => {
  it("stores and retrieves app", () => {
    const id = `app-${Date.now()}-${Math.random()}`;
    expect(getInferenceApp(id)).toBeNull();
    const app = { id, name: "test" } as never;
    setInferenceApp(id, app);
    expect(getInferenceApp(id)).toBe(app);
  });

  it("increments hydration on invalidate", () => {
    const id = `app-${Date.now()}-${Math.random()}-inv`;
    expect(getAppHydrationGeneration(id)).toBe(0);
    invalidateInferenceApp(id);
    expect(getAppHydrationGeneration(id)).toBe(1);
    invalidateInferenceApp(id);
    expect(getAppHydrationGeneration(id)).toBe(2);
    expect(getInferenceApp(id)).toBeNull();
  });

  it("set after invalidate", () => {
    const id = `app-${Date.now()}-${Math.random()}-set`;
    setInferenceApp(id, { id } as never);
    invalidateInferenceApp(id);
    expect(getInferenceApp(id)).toBeNull();
  });
});
