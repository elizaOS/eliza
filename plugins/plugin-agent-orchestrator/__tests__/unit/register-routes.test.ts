/**
 * Verifies register-routes — bundler-safe sentinel export.
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import { describe, expect, it, vi } from "vitest";

// Force the registration branch to run: by default `isLocalCodeExecutionAllowed`
// is false in CI, so `registerCodingAgentRoutePluginLoader` early-returns and the
// `registerAppRoutePluginLoader` call is never exercised. Mock @elizaos/core so
// the real route-registration path is covered.
const { registerAppRoutePluginLoader } = vi.hoisted(() => ({
  registerAppRoutePluginLoader:
    vi.fn<(name: string, loader: () => unknown) => void>(),
}));

vi.mock("@elizaos/core", () => ({
  isLocalCodeExecutionAllowed: () => true,
  registerAppRoutePluginLoader,
}));

import { codingAgentRouteRegistration } from "../../src/register-routes.ts";

describe("register-routes — bundler-safe sentinel export", () => {
  it("exposes a value sentinel that bundlers can latch onto", async () => {
    expect(codingAgentRouteRegistration).toBeDefined();
    expect(codingAgentRouteRegistration).toBe(true);
  });

  it("registers the coding-agent route plugin loader with the runtime", async () => {
    expect(registerAppRoutePluginLoader).toHaveBeenCalledWith(
      "@elizaos/plugin-agent-orchestrator:routes",
      expect.any(Function),
    );
  });
});
