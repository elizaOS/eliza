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
});
