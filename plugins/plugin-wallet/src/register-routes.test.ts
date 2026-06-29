import { describe, expect, it, vi } from "vitest";

const { registerAppRoutePluginLoader } = vi.hoisted(() => ({
  registerAppRoutePluginLoader: vi.fn(),
}));

vi.mock("@elizaos/core", () => ({
  registerAppRoutePluginLoader,
}));

await import("./register-routes.ts");

describe("wallet route registration", () => {
  it("registers its app route plugin loader from the owning plugin", () => {
    expect(registerAppRoutePluginLoader).toHaveBeenCalledWith(
      "@elizaos/plugin-wallet:routes",
      expect.any(Function),
    );
  });
});
