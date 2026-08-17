/** Verifies desktop runtime recovery with deterministic reachability probes. */
import { describe, expect, it, vi } from "vitest";
import { resolveDesktopRuntimeForBoot } from "./runtime-preflight";

const remoteDeployment = {
  runtime: "remote" as const,
  remoteApiBase: "http://127.0.0.1:2250",
};

describe("resolveDesktopRuntimeForBoot", () => {
  it("keeps a reachable persisted remote target external", async () => {
    const probe = vi.fn(async () => true);
    const result = await resolveDesktopRuntimeForBoot({
      env: {},
      deployment: remoteDeployment,
      probe,
    });

    expect(result.mode).toBe("external");
    expect(result.externalApi.base).toBe("http://127.0.0.1:2250");
    expect(probe).toHaveBeenCalledOnce();
  });

  it("recovers an unreachable persisted remote target to embedded local", async () => {
    const result = await resolveDesktopRuntimeForBoot({
      env: {},
      deployment: remoteDeployment,
      probe: async () => false,
    });

    expect(result.mode).toBe("local");
    expect(result.externalApi.base).toBeNull();
  });

  it("does not fabricate local runtime in a cloud-only package", async () => {
    const probe = vi.fn(async () => false);
    const result = await resolveDesktopRuntimeForBoot({
      env: { ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT: "1" },
      deployment: remoteDeployment,
      probe,
    });

    expect(result.mode).toBe("external");
    expect(probe).not.toHaveBeenCalled();
  });

  it("preserves explicit env targets without probing persisted state", async () => {
    const probe = vi.fn(async () => false);
    const result = await resolveDesktopRuntimeForBoot({
      env: { ELIZA_DESKTOP_API_BASE: "http://127.0.0.1:9999" },
      deployment: remoteDeployment,
      probe,
    });

    expect(result.mode).toBe("external");
    expect(result.externalApi.base).toBe("http://127.0.0.1:9999");
    expect(probe).not.toHaveBeenCalled();
  });
});
