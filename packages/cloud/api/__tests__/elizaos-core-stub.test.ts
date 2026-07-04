import { describe, expect, test } from "bun:test";

import {
  DEFAULT_CEREBRAS_TEXT_MODEL,
  DEFAULT_ELIZA_CLOUD_FREE_TEXT_MODEL,
  DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
  fetchWithSsrfGuard,
  runWithTrajectoryPurpose,
  SsrfBlockedError,
} from "../src/stubs/elizaos-core";

describe("elizaos-core Worker stub", () => {
  test("exports the Eliza Cloud default text model aliases used by plugin-elizacloud", () => {
    expect(DEFAULT_CEREBRAS_TEXT_MODEL).toBe("gemma-4-31b");
    expect(DEFAULT_ELIZA_CLOUD_TEXT_MODEL).toBe(DEFAULT_CEREBRAS_TEXT_MODEL);
    expect(DEFAULT_ELIZA_CLOUD_FREE_TEXT_MODEL).toBe(
      DEFAULT_CEREBRAS_TEXT_MODEL,
    );
  });

  test("runWithTrajectoryPurpose runs the fn and returns its result (sync + async)", async () => {
    expect(runWithTrajectoryPurpose("worker-test", () => 41 + 1)).toBe(42);
    await expect(
      runWithTrajectoryPurpose("worker-test", async () => "async-ok"),
    ).resolves.toBe("async-ok");
    expect(() =>
      runWithTrajectoryPurpose("worker-test", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
  });

  describe("fetchWithSsrfGuard", () => {
    const neverFetch = () => {
      throw new Error("fetchImpl must not be reached for a blocked target");
    };

    test("blocks literal private/metadata targets before any fetch", async () => {
      for (const url of [
        "http://169.254.169.254/latest/meta-data/",
        "http://127.0.0.1:8080/",
        "http://10.0.0.5/internal",
        "http://localhost/admin",
        "http://metadata.google.internal/computeMetadata/v1/",
      ]) {
        await expect(
          fetchWithSsrfGuard({ url, fetchImpl: neverFetch }),
        ).rejects.toBeInstanceOf(SsrfBlockedError);
      }
    });

    test("rejects non-http(s) URLs", async () => {
      await expect(
        fetchWithSsrfGuard({
          url: "file:///etc/passwd",
          fetchImpl: neverFetch,
        }),
      ).rejects.toThrow("Invalid URL: must be http or https");
    });

    test("fails CLOSED when a lookupFn is provided without a pinnedFetchImpl", async () => {
      await expect(
        fetchWithSsrfGuard({
          url: "https://example.com/",
          lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
          fetchImpl: neverFetch,
        }),
      ).rejects.toThrow(/lookupFn was provided without a pinnedFetchImpl/);
    });

    test("returns the response for an allowed target via the injected fetchImpl", async () => {
      const { response, finalUrl, release } = await fetchWithSsrfGuard({
        url: "https://example.com/audio.mp3",
        fetchImpl: async () => new Response("ok", { status: 200 }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
      expect(finalUrl).toBe("https://example.com/audio.mp3");
      await release();
    });

    test("re-validates every redirect hop — redirect to a private IP is blocked", async () => {
      let calls = 0;
      const fetchImpl = async () => {
        calls += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        });
      };
      await expect(
        fetchWithSsrfGuard({ url: "https://example.com/start", fetchImpl }),
      ).rejects.toBeInstanceOf(SsrfBlockedError);
      expect(calls).toBe(1);
    });

    test("strips credential headers on a cross-origin redirect", async () => {
      const seenAuth: Array<string | null> = [];
      const fetchImpl = async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const headers = new Headers(init?.headers);
        seenAuth.push(headers.get("authorization"));
        if (String(input).startsWith("https://example.com/")) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://evil.example.net/capture" },
          });
        }
        return new Response("done", { status: 200 });
      };
      const { response, release } = await fetchWithSsrfGuard({
        url: "https://example.com/start",
        init: { headers: { authorization: "Bearer secret" } },
        fetchImpl,
      });
      expect(response.status).toBe(200);
      expect(seenAuth).toEqual(["Bearer secret", null]);
      await release();
    });

    test("caps redirects", async () => {
      let hop = 0;
      const fetchImpl = async () => {
        hop += 1;
        return new Response(null, {
          status: 302,
          headers: { location: `https://example.com/hop-${hop}` },
        });
      };
      await expect(
        fetchWithSsrfGuard({
          url: "https://example.com/start",
          maxRedirects: 2,
          fetchImpl,
        }),
      ).rejects.toThrow("Too many redirects (limit: 2)");
    });
  });
});
