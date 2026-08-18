/**
 * @vitest-environment jsdom
 *
 * FocusView website-blocker JSON through the canonical ElizaClient seam.
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

vi.mock("./FocusSpatialView.tsx", () => ({
  FocusSpatialView: () => null,
}));

import {
  FOCUS_VIEW_JSON_TIMEOUT_MS,
  getFocusJsonWithClient,
} from "./FocusView.js";

const PATH = "/api/website-blocker";

describe("FocusView website-blocker JSON deadline", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("keeps a documented UI JSON budget", () => {
    expect(FOCUS_VIEW_JSON_TIMEOUT_MS).toBe(15_000);
  });

  it("surfaces a timeout from the canonical client", async () => {
    clientFetch.mockRejectedValueOnce(
      new DOMException("The operation timed out", "TimeoutError"),
    );

    await expect(
      getFocusJsonWithClient(PATH, { fetch: clientFetch }, 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(clientFetch).toHaveBeenCalledWith(PATH, undefined, {
      timeoutMs: 10,
    });
  });

  it("surfaces a provider error from the canonical client", async () => {
    clientFetch.mockRejectedValueOnce(
      new Error("Website blocker status request failed (503)."),
    );

    await expect(
      getFocusJsonWithClient(PATH, { fetch: clientFetch }, 1_000),
    ).rejects.toThrow("503");
  });

  it("uses the bounded client path for a successful blocker GET", async () => {
    clientFetch.mockResolvedValueOnce({ active: false });

    await expect(
      getFocusJsonWithClient(PATH, { fetch: clientFetch }, 1_000),
    ).resolves.toEqual({ active: false });
    expect(clientFetch).toHaveBeenCalledWith(PATH, undefined, {
      timeoutMs: 1_000,
    });
  });
});
