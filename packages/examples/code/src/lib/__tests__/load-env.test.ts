import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  config: vi.fn(),
}));

vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }));
vi.mock("dotenv", () => ({ config: mocks.config }));

import { loadEnv } from "../load-env.ts";

describe("loadEnv", () => {
  beforeEach(() => {
    mocks.config.mockClear();
    mocks.existsSync.mockClear();
  });

  it("loads cwd .env always, and root .env only when present", () => {
    mocks.existsSync.mockReturnValue(true);
    loadEnv();
    expect(mocks.config).toHaveBeenCalledTimes(2);
    // First call: default cwd behavior
    expect(mocks.config.mock.calls[0][0]).toMatchObject({ quiet: true });
    // Second call: root .env with no override
    expect(mocks.config.mock.calls[1][0]).toMatchObject({
      override: false,
      quiet: true,
    });
    expect(mocks.config.mock.calls[1][0].path).toContain(".env");
  });

  it("skips the root .env when it does not exist", () => {
    mocks.existsSync.mockReturnValue(false);
    loadEnv();
    expect(mocks.config).toHaveBeenCalledTimes(1);
  });

  it("probes an absolute monorepo-root .env path derived from this module", () => {
    mocks.existsSync.mockReturnValue(true);
    loadEnv();
    expect(mocks.existsSync).toHaveBeenCalledTimes(1);
    const probed = String(mocks.existsSync.mock.calls[0]?.[0]);
    const normalized = probed.split(/[/\\]/).join("/");
    expect(normalized.endsWith("/packages/.env")).toBe(true);
  });

  it("loads cwd .env through dotenv defaults so shell env is never clobbered", () => {
    mocks.existsSync.mockReturnValue(true);
    loadEnv();
    const cwdOptions = (mocks.config.mock.calls[0]?.[0] ?? {}) as {
      path?: unknown;
      override?: unknown;
      quiet?: unknown;
    };
    expect(cwdOptions.quiet).toBe(true);
    expect(cwdOptions).not.toHaveProperty("path");
    expect(cwdOptions.override).toBeUndefined();
  });

  it("loads exactly the root .env path it probed", () => {
    mocks.existsSync.mockReturnValue(true);
    loadEnv();
    const probed = String(mocks.existsSync.mock.calls[0]?.[0]);
    const rootOptions = (mocks.config.mock.calls[1]?.[0] ?? {}) as {
      path?: unknown;
    };
    expect(rootOptions.path).toBe(probed);
  });
});
