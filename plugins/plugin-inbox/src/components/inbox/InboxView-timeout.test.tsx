/**
 * @vitest-environment jsdom
 *
 * InboxView inbox JSON through the canonical ElizaClient seam.
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
  getInboxJsonWithClient,
  INBOX_VIEW_JSON_TIMEOUT_MS,
} from "./InboxView.js";

const PATH = "/api/lifeops/inbox";

describe("InboxView inbox JSON deadline", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("keeps a documented UI JSON budget", () => {
    expect(INBOX_VIEW_JSON_TIMEOUT_MS).toBe(15_000);
  });

  it("surfaces a timeout from the canonical client", async () => {
    clientFetch.mockRejectedValueOnce(
      new DOMException("The operation timed out", "TimeoutError"),
    );

    await expect(
      getInboxJsonWithClient(PATH, { fetch: clientFetch }, 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(clientFetch).toHaveBeenCalledWith(PATH, undefined, {
      timeoutMs: 10,
    });
  });

  it("surfaces a provider error from the canonical client", async () => {
    clientFetch.mockRejectedValueOnce(new Error("Inbox request failed (503)"));

    await expect(
      getInboxJsonWithClient(PATH, { fetch: clientFetch }, 1_000),
    ).rejects.toThrow("503");
  });

  it("uses the bounded client path for a successful inbox GET", async () => {
    clientFetch.mockResolvedValueOnce({ items: [] });

    await expect(
      getInboxJsonWithClient(PATH, { fetch: clientFetch }, 1_000),
    ).resolves.toEqual({ items: [] });
    expect(clientFetch).toHaveBeenCalledWith(PATH, undefined, {
      timeoutMs: 1_000,
    });
  });
});
