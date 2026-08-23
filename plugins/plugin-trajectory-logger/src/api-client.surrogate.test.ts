/**
 * Regression for #24933: surrogate-safe bounded preview and read-failure translation.
 * Mirrors broker astral boundary test: 199+"🦊"+50 straddling 200.
 * Asserts isWellFormed and exact prefix so old slice would fail.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTrajectoryList, TrajectoryHttpError } from "./api-client.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("trajectory-logger surrogate-safe error preview (#24933)", () => {
  it("surfaces a bounded well-formed preview without splitting astral at 200", async () => {
    const astral = "🦊";
    const body = "a".repeat(199) + astral + "b".repeat(50);
    expect(body.length).toBe(199 + 2 + 50);
    // Verify old slice would be ill-formed: it would split astral
    const oldSlice = body.slice(0, 200);
    expect(oldSlice.charCodeAt(199)).toBe(0xd83e);
    expect(oldSlice.isWellFormed()).toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => body,
      })) as unknown as typeof fetch,
    );
    await expect(fetchTrajectoryList()).rejects.toThrow(TrajectoryHttpError);
    try {
      await fetchTrajectoryList();
    } catch (error) {
      const message = (error as Error).message;
      const preview = message.split(": ").pop() ?? "";
      // Truncate should back off to 199 to avoid splitting astral
      expect(preview).toBe("a".repeat(199));
      expect(preview.length).toBe(199);
      expect(preview.isWellFormed()).toBe(true);
      expect(message).toContain("500 Internal Server Error:");
    }
  });

  it("replaces lone surrogate via toWellFormedUnicode before truncation", async () => {
    const lone = "\uD800";
    const body = lone + "x".repeat(250);
    expect(body.isWellFormed()).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: async () => body,
      })) as unknown as typeof fetch,
    );
    try {
      await fetchTrajectoryList();
      expect.fail("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      const preview = message.split(": ").pop() ?? "";
      expect(preview.isWellFormed()).toBe(true);
      expect(message).not.toContain("\uD800");
      expect(message).toContain("�");
      expect(preview.length).toBeLessThanOrEqual(200);
      // Direct constructor path also well-formed
      const direct = new TrajectoryHttpError(500, "err", lone + "a".repeat(199));
      expect(direct.message.isWellFormed()).toBe(true);
      expect(direct.message).not.toContain("\uD800");
      expect(direct.message).toContain("�");
    }
  });

  it("translates body-read failure without fabricating empty preview", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
            text: async () => {
              throw new Error("body read failed");
            },
          }) as unknown as Response,
      ),
    );
    await expect(fetchTrajectoryList()).rejects.toThrow(
      "[trajectory-logger] 500 Internal Server Error: [unreadable]",
    );
  });
});
