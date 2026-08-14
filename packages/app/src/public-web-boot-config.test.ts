/**
 * Ensures the lightweight public entry seeds environment-derived Cloud API
 * config before join/auth routes read it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: { cloudApiBase: "https://eliza.app", marker: "preserved" },
  setCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@elizaos/ui/config", () => ({
  getBootConfig: () => state.config,
  setBootConfig: (next: Record<string, unknown>) => {
    state.config = next as typeof state.config;
    state.setCalls.push(next);
  },
}));

vi.mock("./ios-runtime", () => ({
  resolveIosRuntimeConfig: (
    env: Record<string, string | boolean | undefined>,
  ) => ({
    cloudApiBase:
      typeof env.VITE_ELIZA_CLOUD_BASE === "string"
        ? env.VITE_ELIZA_CLOUD_BASE.replace(/\/+$/, "")
        : "https://eliza.app",
  }),
}));

import { seedPublicWebBootConfig } from "./public-web-boot-config.js";

describe("seedPublicWebBootConfig", () => {
  beforeEach(() => {
    state.config = {
      cloudApiBase: "https://eliza.app",
      marker: "preserved",
    };
    state.setCalls.length = 0;
  });

  it("applies the staging Cloud base while preserving existing boot fields", () => {
    seedPublicWebBootConfig({
      VITE_ELIZA_CLOUD_BASE: "https://cloud-staging.eliza.app/",
    });

    expect(state.config).toEqual({
      cloudApiBase: "https://cloud-staging.eliza.app",
      marker: "preserved",
    });
    expect(state.setCalls).toHaveLength(1);
  });

  it("is idempotent when the environment-derived base already matches", () => {
    state.config.cloudApiBase = "https://cloud-staging.eliza.app";

    seedPublicWebBootConfig({
      VITE_ELIZA_CLOUD_BASE: "https://cloud-staging.eliza.app",
    });

    expect(state.setCalls).toHaveLength(0);
    expect(state.config.marker).toBe("preserved");
  });
});
