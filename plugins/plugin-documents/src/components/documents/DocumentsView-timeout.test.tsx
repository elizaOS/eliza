/**
 * @vitest-environment jsdom
 *
 * DocumentsView documents JSON through the canonical ElizaClient seam.
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

vi.mock("./DocumentsSpatialView.tsx", () => ({
  DocumentsSpatialView: () => null,
}));

import {
  DOCUMENTS_VIEW_JSON_TIMEOUT_MS,
  getDocumentsJsonWithClient,
} from "./DocumentsView.js";

const PATH = "/api/documents?limit=100&offset=0";

describe("DocumentsView documents JSON deadline", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("keeps a documented UI JSON budget", () => {
    expect(DOCUMENTS_VIEW_JSON_TIMEOUT_MS).toBe(15_000);
  });

  it("surfaces a timeout from the canonical client", async () => {
    clientFetch.mockRejectedValueOnce(
      new DOMException("The operation timed out", "TimeoutError"),
    );

    await expect(
      getDocumentsJsonWithClient(PATH, { fetch: clientFetch }, 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(clientFetch).toHaveBeenCalledWith(PATH, undefined, {
      timeoutMs: 10,
    });
  });

  it("surfaces a provider error from the canonical client", async () => {
    clientFetch.mockRejectedValueOnce(
      new Error(`Documents request failed (503): ${PATH}`),
    );

    await expect(
      getDocumentsJsonWithClient(PATH, { fetch: clientFetch }, 1_000),
    ).rejects.toThrow("503");
  });

  it("uses the bounded client path for a successful documents GET", async () => {
    clientFetch.mockResolvedValueOnce({ documents: [] });

    await expect(
      getDocumentsJsonWithClient(PATH, { fetch: clientFetch }, 1_000),
    ).resolves.toEqual({ documents: [] });
    expect(clientFetch).toHaveBeenCalledWith(PATH, undefined, {
      timeoutMs: 1_000,
    });
  });
});
