import { afterEach, describe, expect, it, vi } from "vitest";
import type { FrontendPlatform } from "../../platform/platform-guards";

const getFrontendPlatform = vi.hoisted(() => vi.fn<() => FrontendPlatform>());

vi.mock("../../platform/platform-guards", () => ({
  getFrontendPlatform,
}));

const {
  canServeRuntimeClassOnPlatform,
  runtimeClassBadge,
  runtimeClassDescription,
  runtimeClassUnavailableReason,
} = await import("./runtime-class-ui");

afterEach(() => {
  getFrontendPlatform.mockReset();
});

// RuntimeClass collapsed to the single fused Eliza-1 tier (eliza-1-only cutover,
// #9033); the generic-gguf path was removed, so the helpers only handle the one
// class now.
describe("runtimeClassBadge", () => {
  it("labels fused Eliza-1 as eliza-1", () => {
    expect(runtimeClassBadge("fused-eliza1")).toBe("eliza-1");
  });
});

describe("runtimeClassDescription", () => {
  it("describes the optimization tier", () => {
    expect(runtimeClassDescription("fused-eliza1")).toBe(
      "eliza-1 — full pipeline",
    );
  });
});

describe("canServeRuntimeClassOnPlatform", () => {
  it("serves fused Eliza-1 on every platform without consulting the guard", () => {
    getFrontendPlatform.mockReturnValue("desktop");
    expect(canServeRuntimeClassOnPlatform("fused-eliza1")).toBe(true);
    expect(getFrontendPlatform).not.toHaveBeenCalled();
  });
});

describe("runtimeClassUnavailableReason", () => {
  it("returns null for a servable pick", () => {
    getFrontendPlatform.mockReturnValue("desktop");
    expect(runtimeClassUnavailableReason("fused-eliza1")).toBeNull();
  });
});
