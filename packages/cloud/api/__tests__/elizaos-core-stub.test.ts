// Exercises cloud API tests elizaos core stub.test behavior with deterministic Worker route fixtures.
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

  test("runWithTrajectoryPurpose runs the callback and returns its result", async () => {
    await expect(
      runWithTrajectoryPurpose("inbox_triage", async () => "ok"),
    ).resolves.toBe("ok");
  });

  describe("fetchWithSsrfGuard", () => {
    const noFetch = () => {
      throw new Error("fetch must not be reached for a blocked URL");
    };

    test("blocks non-http(s) schemes, localhost, internal names, and private/reserved IPs", async () => {
      const blocked = [
        "file:///etc/passwd",
        "ftp://example.com/x",
        "http://localhost/x",
        "http://sub.localhost/x",
        "http://metadata.google.internal/computeMetadata/v1/",
        "http://foo.internal/x",
        "http://printer.local/x",
        "http://127.0.0.1/x",
        "http://10.1.2.3/x",
        "http://169.254.169.254/latest/meta-data/",
        "http://172.16.0.1/x",
        "http://192.168.1.1/x",
        "http://100.64.0.1/x",
        "http://0.0.0.0/x",
        "http://[::1]/x",
        "http://[fe80::1]/x",
        "http://[fd00::1]/x",
        "http://[::ffff:127.0.0.1]/x",
      ];
      for (const url of blocked) {
        await expect(
          fetchWithSsrfGuard({ url, fetchImpl: noFetch }),
        ).rejects.toBeInstanceOf(SsrfBlockedError);
      }
    });

    test("fetches an allowed URL and returns { response, finalUrl, release }", async () => {
      const { response, finalUrl, release } = await fetchWithSsrfGuard({
        url: "https://example.com/audio.mp3",
        fetchImpl: async () => new Response("bytes", { status: 200 }),
      });
      expect(response.status).toBe(200);
      expect(finalUrl).toBe("https://example.com/audio.mp3");
      await expect(response.text()).resolves.toBe("bytes");
      await release();
    });

    test("follows redirects manually, re-validates every hop, and strips credentials cross-origin", async () => {
      const seen: Array<{ url: string; auth: string | null }> = [];
      const fetchImpl = async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const url = String(input);
        seen.push({
          url,
          auth: new Headers(init?.headers).get("authorization"),
        });
        if (url === "https://a.example.com/start") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://b.example.com/next" },
          });
        }
        return new Response("done", { status: 200 });
      };
      const { response, finalUrl } = await fetchWithSsrfGuard({
        url: "https://a.example.com/start",
        init: { headers: { authorization: "Bearer secret" } },
        fetchImpl,
      });
      expect(response.status).toBe(200);
      expect(finalUrl).toBe("https://b.example.com/next");
      expect(seen[0]?.auth).toBe("Bearer secret");
      expect(seen[1]?.auth).toBeNull(); // stripped on the cross-origin hop
    });

    test("blocks a redirect that targets an internal address", async () => {
      await expect(
        fetchWithSsrfGuard({
          url: "https://a.example.com/start",
          fetchImpl: async () =>
            new Response(null, {
              status: 302,
              headers: { location: "http://169.254.169.254/latest/meta-data/" },
            }),
        }),
      ).rejects.toBeInstanceOf(SsrfBlockedError);
    });

    test("gives up after maxRedirects hops", async () => {
      await expect(
        fetchWithSsrfGuard({
          url: "https://a.example.com/loop",
          maxRedirects: 2,
          fetchImpl: async (input) =>
            new Response(null, {
              status: 302,
              headers: { location: `${String(input)}x` },
            }),
        }),
      ).rejects.toBeInstanceOf(SsrfBlockedError);
    });
  });
});
