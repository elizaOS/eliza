import { afterEach, describe, expect, it, vi } from "vitest";
import type { FrontendPlatform } from "../../platform/platform-guards";

const getFrontendPlatform = vi.hoisted(() =>
  vi.fn<() => FrontendPlatform>(),
);

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

describe("runtimeClassBadge", () => {
  it("labels fused Eliza-1 as eliza-1 and everything else as generic", () => {
    expect(runtimeClassBadge("fused-eliza1")).toBe("eliza-1");
    expect(runtimeClassBadge("generic-gguf")).toBe("generic");
  });
});

describe("runtimeClassDescription", () => {
  it("describes the optimization tier", () => {
    expect(runtimeClassDescription("fused-eliza1")).toBe(
      "eliza-1 — full pipeline",
    );
    expect(runtimeClassDescription("generic-gguf")).toBe(
      "generic — reduced optimizations",
    );
  });
});

describe("canServeRuntimeClassOnPlatform", () => {
  it("serves fused Eliza-1 on every platform without consulting the guard", () => {
    getFrontendPlatform.mockReturnValue("desktop");
    expect(canServeRuntimeClassOnPlatform("fused-eliza1")).toBe(true);
    expect(getFrontendPlatform).not.toHaveBeenCalled();
  });

  it("serves generic GGUF only on mobile platforms", () => {
    getFrontendPlatform.mockReturnValue("ios");
    expect(canServeRuntimeClassOnPlatform("generic-gguf")).toBe(true);

    getFrontendPlatform.mockReturnValue("android");
    expect(canServeRuntimeClassOnPlatform("generic-gguf")).toBe(true);

    getFrontendPlatform.mockReturnValue("desktop");
    expect(canServeRuntimeClassOnPlatform("generic-gguf")).toBe(false);

    getFrontendPlatform.mockReturnValue("web");
    expect(canServeRuntimeClassOnPlatform("generic-gguf")).toBe(false);
  });
});

describe("runtimeClassUnavailableReason", () => {
  it("returns null for a servable pick", () => {
    getFrontendPlatform.mockReturnValue("desktop");
    expect(runtimeClassUnavailableReason("fused-eliza1")).toBeNull();

    getFrontendPlatform.mockReturnValue("ios");
    expect(runtimeClassUnavailableReason("generic-gguf")).toBeNull();
  });

  it("explains why a generic GGUF can't run off-mobile", () => {
    getFrontendPlatform.mockReturnValue("desktop");
    expect(runtimeClassUnavailableReason("generic-gguf")).toBe(
      "Not runnable on this platform — generic GGUF needs a mobile build",
    );
  });
});
