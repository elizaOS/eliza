import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger";
import { LocationManager } from "./location";

vi.mock("../logger", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

const originalFetch = globalThis.fetch;

describe("LocationManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("logs failed IP geolocation providers before returning no position", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    await expect(
      new LocationManager().getCurrentPosition(),
    ).resolves.toBeNull();

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      "[Location] IP geolocation provider failed",
      expect.objectContaining({
        error: "network down",
        url: expect.any(String),
      }),
    );
  });
});
