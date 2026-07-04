/** Verifies the website-blocking permission prober registers against a present permissions registry. Deterministic vitest with a stubbed registry. */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { registerLifeOpsWebsiteBlockingPermissionProber } from "./plugin.js";

describe("LifeOps website-blocking permission prober", () => {
  it("registers the website-blocking prober when a permissions registry is present", () => {
    const registerProber = vi.fn();
    const registry = {
      get: vi.fn(),
      check: vi.fn(),
      request: vi.fn(),
      openSettings: vi.fn(),
      registerProber,
    };
    const runtime = {
      getService: vi.fn((serviceType: string) =>
        serviceType === "eliza_permissions_registry" ? registry : null,
      ),
    } as unknown as IAgentRuntime;

    expect(registerLifeOpsWebsiteBlockingPermissionProber(runtime)).toBe(true);

    expect(registerProber).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "website-blocking",
        check: expect.any(Function),
        request: expect.any(Function),
        openSettings: expect.any(Function),
      }),
    );
  });

  it("skips registration when the permissions registry is absent", () => {
    const runtime = {
      getService: vi.fn(() => null),
    } as unknown as IAgentRuntime;

    expect(registerLifeOpsWebsiteBlockingPermissionProber(runtime)).toBe(false);
  });
});
