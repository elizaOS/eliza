/** Checks idempotent host registration through a mocked view-importer registry. */
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
    registerAppHostExternalImporters();
    expect(mocks.registerHostExternalImporter).toHaveBeenCalledTimes(2);
    expect(mocks.registerHostExternalImporter.mock.calls[0][0]).toBe(
      "@elizaos/plugin-browser",
    );
    expect(mocks.registerHostExternalImporter.mock.calls[1][0]).toContain(
      "@elizaos/plugin-health",
    );
  });
});
