/**
 * Failure-path tests for `ensureModelAvailable` (#12796).
 *
 * The model-discovery/auto-download bootstrap must DISTINGUISH its failure modes
 * and surface them to the caller — it must never swallow a "daemon unreachable"
 * or "pull failed" into a silent success that lets inference proceed against a
 * model the daemon does not have. These tests pin that contract:
 *   - `/api/show` 200 → returns (present)
 *   - `/api/show` fetch rejects → throws OllamaModelUnavailableError(daemon-unreachable)
 *   - `/api/show` non-200 then `/api/pull` 200 → returns (downloaded)
 *   - `/api/show` non-200 then `/api/pull` non-200 → throws (pull-failed, carries status)
 *   - `/api/show` non-200 then `/api/pull` fetch rejects → throws (pull-failed)
 */
import { describe, expect, it, vi } from "vitest";

import { ensureModelAvailable, OllamaModelUnavailableError } from "../models/availability";

function okResponse(): Response {
  return { ok: true, status: 200, statusText: "OK" } as Response;
}

function notFoundResponse(): Response {
  return { ok: false, status: 404, statusText: "Not Found" } as Response;
}

describe("ensureModelAvailable (#12796 bootstrap failure policy)", () => {
  it("returns without a pull when /api/show reports the model present", async () => {
    const fetcher = vi.fn(async () => okResponse()) as unknown as typeof fetch;

    await expect(
      ensureModelAvailable("eliza-1-2b", "http://host:11434/api", fetcher)
    ).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      String((fetcher as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0])
    ).toContain("/api/show");
  });

  it("throws daemon-unreachable (not 'model absent') when /api/show cannot connect", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    }) as unknown as typeof fetch;

    const err = await ensureModelAvailable("eliza-1-2b", "http://host:11434/api", fetcher).catch(
      (e) => e
    );

    expect(err).toBeInstanceOf(OllamaModelUnavailableError);
    expect((err as OllamaModelUnavailableError).reason).toBe("daemon-unreachable");
    expect((err as OllamaModelUnavailableError).model).toBe("eliza-1-2b");
    // The daemon was never asked to pull — we could not even reach /api/show.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("pulls and returns when /api/show misses but /api/pull succeeds", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(notFoundResponse())
      .mockResolvedValueOnce(okResponse()) as unknown as typeof fetch;

    await expect(
      ensureModelAvailable("eliza-1-2b", "http://host:11434/api", fetcher)
    ).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      String((fetcher as unknown as { mock: { calls: unknown[][] } }).mock.calls[1][0])
    ).toContain("/api/pull");
  });

  it("throws pull-failed (does NOT proceed) when the pull request is rejected by the daemon", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(notFoundResponse())
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      } as Response) as unknown as typeof fetch;

    const err = await ensureModelAvailable("nope-model", "http://host:11434/api", fetcher).catch(
      (e) => e
    );

    expect(err).toBeInstanceOf(OllamaModelUnavailableError);
    expect((err as OllamaModelUnavailableError).reason).toBe("pull-failed");
    expect((err as OllamaModelUnavailableError).status).toBe(500);
    expect((err as OllamaModelUnavailableError).model).toBe("nope-model");
  });

  it("throws pull-failed when the pull request itself cannot reach the daemon", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(notFoundResponse())
      .mockRejectedValueOnce(new Error("socket hang up")) as unknown as typeof fetch;

    const err = await ensureModelAvailable("eliza-1-4b", "http://host:11434/api", fetcher).catch(
      (e) => e
    );

    expect(err).toBeInstanceOf(OllamaModelUnavailableError);
    expect((err as OllamaModelUnavailableError).reason).toBe("pull-failed");
    expect((err as OllamaModelUnavailableError).model).toBe("eliza-1-4b");
  });
});
