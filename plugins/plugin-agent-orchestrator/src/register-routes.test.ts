import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isLocalCodeExecutionAllowed: vi.fn(),
  registerAppRoutePluginLoader: vi.fn(),
}));

vi.mock("@elizaos/core", () => mocks);

async function loadModule() {
  vi.resetModules();
  return import("./register-routes");
}

beforeEach(() => {
  mocks.isLocalCodeExecutionAllowed.mockReset();
  mocks.registerAppRoutePluginLoader.mockReset();
});

describe("register-routes permission gate", () => {
  it("exports the registration sentinel after module evaluation", async () => {
    mocks.isLocalCodeExecutionAllowed.mockReturnValue(false);
    const mod = await loadModule();
    expect(mod.codingAgentRouteRegistration).toBe(true);
  });

  it("skips registration when local code execution is not allowed", async () => {
    mocks.isLocalCodeExecutionAllowed.mockReturnValue(false);
    await loadModule();
    expect(mocks.registerAppRoutePluginLoader).not.toHaveBeenCalled();
  });

  it("registers the route plugin loader only when local execution is allowed", async () => {
    mocks.isLocalCodeExecutionAllowed.mockReturnValue(true);
    await loadModule();
    expect(mocks.registerAppRoutePluginLoader).toHaveBeenCalledTimes(1);
    expect(mocks.registerAppRoutePluginLoader).toHaveBeenCalledWith(
      "@elizaos/plugin-agent-orchestrator:routes",
      expect.any(Function),
    );
  });

  it("the registered loader resolves the coding-agent route plugin lazily", async () => {
    mocks.isLocalCodeExecutionAllowed.mockReturnValue(true);
    await loadModule();
    const loader = mocks.registerAppRoutePluginLoader.mock.calls[0][1];
    const plugin = await loader();
    expect(plugin).toEqual({
      name: "coding-agent-routes",
      kind: "route-plugin",
    });
  });

  it("registration is a side effect of module evaluation, not of the sentinel read", async () => {
    mocks.isLocalCodeExecutionAllowed.mockReturnValue(true);
    await loadModule();
    // Re-reading the module from cache must not re-register.
    const again = await import("./register-routes");
    expect(again.codingAgentRouteRegistration).toBe(true);
    expect(mocks.registerAppRoutePluginLoader).toHaveBeenCalledTimes(1);
  });
});
