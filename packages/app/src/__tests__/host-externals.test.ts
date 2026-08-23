import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  registerHostExternalImporter: vi.fn(),
}));

vi.mock("@elizaos/ui/app-shell-registry", () => ({
  registerHostExternalImporter: (
    specifier: string,
    importer: () => Promise<Record<string, unknown>>,
  ) => mocks.registerHostExternalImporter(specifier, importer),
}));

describe("registerAppHostExternalImporters", () => {
  beforeEach(() => {
    mocks.registerHostExternalImporter.mockReset();
    vi.resetModules();
  });

  it("registers the plugin-browser and health specifiers once", async () => {
    const { registerAppHostExternalImporters } = await import(
      "../host-externals.ts"
    );
    registerAppHostExternalImporters();
    registerAppHostExternalImporters(); // second call is a no-op
    expect(mocks.registerHostExternalImporter).toHaveBeenCalledTimes(2);
    expect(mocks.registerHostExternalImporter.mock.calls[0][0]).toBe(
      "@elizaos/plugin-browser",
    );
    expect(mocks.registerHostExternalImporter.mock.calls[1][0]).toContain(
      "@elizaos/plugin-health",
    );
  });

  it("registers thunks that return promises", async () => {
    const { registerAppHostExternalImporters } = await import(
      "../host-externals.ts"
    );
    registerAppHostExternalImporters();
    for (const call of mocks.registerHostExternalImporter.mock.calls) {
      const thunk = call[1] as () => Promise<unknown>;
      expect(typeof thunk).toBe("function");
      const result = thunk();
      expect(result).toBeInstanceOf(Promise);
      await result.catch(() => undefined); // 动态 import 可能失败，吞掉
    }
  });
});
