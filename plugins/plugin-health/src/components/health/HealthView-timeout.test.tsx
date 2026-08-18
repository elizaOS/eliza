/**
 * @vitest-environment jsdom
 *
 * HealthView sleep JSON through the canonical ElizaClient seam.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { clientFetch } = vi.hoisted(() => ({
  clientFetch: vi.fn(),
}));

vi.mock("@elizaos/ui/api", () => ({
  client: {
    fetch: clientFetch,
    getBaseUrl: () => "http://test.local",
  },
}));

import {
  getHealthJsonWithClient,
  HEALTH_VIEW_JSON_TIMEOUT_MS,
} from "./HealthView.js";

const PATH = "/api/lifeops/sleep/history?windowDays=14";

describe("HealthView sleep JSON deadline", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("keeps a documented UI JSON budget", () => {
    expect(HEALTH_VIEW_JSON_TIMEOUT_MS).toBe(15_000);
  });

  it("surfaces a timeout from the canonical client", async () => {
    clientFetch.mockRejectedValueOnce(
      new DOMException("The operation timed out", "TimeoutError"),
    );

    await expect(
      getHealthJsonWithClient(PATH, { fetch: clientFetch }, 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(clientFetch).toHaveBeenCalledWith(PATH, undefined, {
      timeoutMs: 10,
    });
  });

  it("surfaces a provider error from the canonical client", async () => {
    clientFetch.mockRejectedValueOnce(
      new Error(`Sleep request failed (503): ${PATH}`),
    );

    await expect(
      getHealthJsonWithClient(PATH, { fetch: clientFetch }, 1_000),
    ).rejects.toThrow("503");
  });

  it("uses the bounded client path for a successful sleep GET", async () => {
    clientFetch.mockResolvedValueOnce({ episodes: [] });

    await expect(
      getHealthJsonWithClient(PATH, { fetch: clientFetch }, 1_000),
    ).resolves.toEqual({ episodes: [] });
    expect(clientFetch).toHaveBeenCalledWith(PATH, undefined, {
      timeoutMs: 1_000,
    });
  });
});
