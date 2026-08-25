/**
 * Coverage for the Eliza version resolver: precedence order, module-not-found
 * swallowing, env override, and the 0.0.0 fallback. createRequire is mocked so
 * package/build-info lookups are deterministic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createRequire: vi.fn(),
}));

vi.mock("node:module", () => ({
  createRequire: mocks.createRequire,
}));

type VersionModule = {
  resolveElizaVersion: (moduleUrl: string) => string;
};

async function loadResolver(): Promise<VersionModule> {
  vi.resetModules();
  return import("./version-resolver.ts");
}

function makeRequireFn(
  overrides: {
    packageJson?: unknown;
    buildInfos?: Record<string, unknown>;
  } = {},
) {
  const packageJson = overrides.packageJson;
  const buildInfos = overrides.buildInfos ?? {};
  return vi.fn((specifier: string) => {
    if (specifier === "../../package.json") {
      if (packageJson === undefined) {
        const err = new Error("module not found") as NodeJS.ErrnoException;
        err.code = "MODULE_NOT_FOUND";
        throw err;
      }
      return packageJson;
    }
    if (specifier in buildInfos) {
      return buildInfos[specifier];
    }
    const err = new Error("module not found") as NodeJS.ErrnoException;
    err.code = "MODULE_NOT_FOUND";
    throw err;
  });
}

beforeEach(() => {
  mocks.createRequire.mockReset();
  delete process.env.ELIZA_BUNDLED_VERSION;
});

describe("resolveElizaVersion", () => {
  it("prefers the build-injected __ELIZA_VERSION__ global", async () => {
    const g = globalThis as Record<string, unknown>;
    const previous = g.__ELIZA_VERSION__;
    g.__ELIZA_VERSION__ = "9.9.9";
    try {
      mocks.createRequire.mockReturnValue(makeRequireFn());
      const mod = await loadResolver();
      expect(mod.resolveElizaVersion("/tmp/x")).toBe("9.9.9");
    } finally {
      if (previous === undefined) delete g.__ELIZA_VERSION__;
      else g.__ELIZA_VERSION__ = previous;
    }
  });

  it("falls back to the ELIZA_BUNDLED_VERSION env var", async () => {
    process.env.ELIZA_BUNDLED_VERSION = "2.3.4";
    mocks.createRequire.mockReturnValue(makeRequireFn());
    const mod = await loadResolver();
    expect(mod.resolveElizaVersion("/tmp/x")).toBe("2.3.4");
  });

  it("reads the version from package.json", async () => {
    mocks.createRequire.mockReturnValue(
      makeRequireFn({ packageJson: { version: "1.2.3" } }),
    );
    const mod = await loadResolver();
    expect(mod.resolveElizaVersion("/tmp/x")).toBe("1.2.3");
  });

  it("reads the version from a build-info candidate", async () => {
    mocks.createRequire.mockReturnValue(
      makeRequireFn({
        packageJson: undefined,
        buildInfos: { "../../build-info.json": { version: "0.5.0" } },
      }),
    );
    const mod = await loadResolver();
    expect(mod.resolveElizaVersion("/tmp/x")).toBe("0.5.0");
  });

  it("tries later build-info candidates when the first is missing", async () => {
    mocks.createRequire.mockReturnValue(
      makeRequireFn({
        buildInfos: { "../build-info.json": { version: "0.6.0" } },
      }),
    );
    const mod = await loadResolver();
    expect(mod.resolveElizaVersion("/tmp/x")).toBe("0.6.0");
  });

  it("falls back to 0.0.0 when every source is missing", async () => {
    mocks.createRequire.mockReturnValue(makeRequireFn());
    const mod = await loadResolver();
    expect(mod.resolveElizaVersion("/tmp/x")).toBe("0.0.0");
  });

  it("propagates non-module-not-found require errors", async () => {
    const requireFn = vi.fn(() => {
      throw new Error("EACCES: permission denied");
    });
    mocks.createRequire.mockReturnValue(requireFn as never);
    const mod = await loadResolver();
    expect(() => mod.resolveElizaVersion("/tmp/x")).toThrow(/EACCES/);
  });
});
