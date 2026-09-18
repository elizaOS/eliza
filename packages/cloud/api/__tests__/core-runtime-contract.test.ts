/** Cloud consumers use canonical core security helpers without a duplicated shim. */
import { describe, expect, test } from "bun:test";
import { toWellFormedUnicode } from "@elizaos/common";
import {
  fetchWithSsrfGuard as canonicalFetch,
  type GuardedFetchOptions,
  getInferenceTimer,
  hasDocumentAugmentationEnvelope,
  runWithTrajectoryPurpose,
  SsrfBlockedError,
  stripAugmentationForPersistence,
  stripHtmlRawTextElements,
} from "@elizaos/core";

/** Inject only the transport; the production guard resolves and validates every hop. */
function fetchWithSsrfGuard(options: GuardedFetchOptions) {
  return canonicalFetch({
    ...options,
    pinnedFetchImpl: options.lookupFn
      ? async ({ url, init, addresses }) => {
          expect(addresses.length).toBeGreaterThan(0);
          return (options.fetchImpl ?? fetch)(url, init);
        }
      : undefined,
  });
}

describe("canonical cloud runtime helpers", () => {
  test("runWithTrajectoryPurpose runs the callback and returns its result", async () => {
    await expect(
      runWithTrajectoryPurpose("inbox_triage", async () => "ok"),
    ).resolves.toBe("ok");
  });

  test("exposes the Worker-safe empty inference timing context", () => {
    expect(getInferenceTimer()).toBeUndefined();
  });

  test("re-exports canonical pure text sanitizers used by Worker consumers", () => {
    expect(
      stripHtmlRawTextElements(
        "before<script><!--<script>hidden</script>still-hidden</script>after",
      ),
    ).toBe("before after");
    expect(toWellFormedUnicode("before\ud83dafter")).toBe("before�after");
  });

  test("strips document augmentation before Worker-side persistence", () => {
    const message = {
      content: {
        text: [
          "Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
          "",
          "<contextual_documents>",
          "source text",
          "</contextual_documents>",
          "",
          "<user_request>",
          "just fixing eliza app for demo",
          "[Language instruction: Reply in Spanish]",
          "</user_request>",
        ].join("\n"),
      },
    };

    expect(hasDocumentAugmentationEnvelope(message.content.text)).toBe(true);
    expect(stripAugmentationForPersistence(message)).toEqual({
      content: { text: "just fixing eliza app for demo" },
    });
  });

  describe("fetchWithSsrfGuard", () => {
    const noFetch = () => {
      throw new Error("fetch must not be reached for a blocked URL");
    };
    // Tests inject a deterministic resolver so no real DNS is needed; the
    // address is a public one (example.com's 93.184.216.34).
    const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

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
        ).rejects.toThrow();
      }
    });

    test("fetches an allowed URL and returns { response, finalUrl, release }", async () => {
      const { response, finalUrl, release } = await fetchWithSsrfGuard({
        url: "https://example.com/audio.mp3",
        fetchImpl: async () => new Response("bytes", { status: 200 }),
        lookupFn: publicDns,
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
        lookupFn: publicDns,
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
          lookupFn: publicDns,
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
          lookupFn: publicDns,
          fetchImpl: async (input) =>
            new Response(null, {
              status: 302,
              headers: { location: `${String(input)}x` },
            }),
        }),
      ).rejects.toThrow("Too many redirects");
    });

    test("blocks a public hostname that resolves to a private/reserved address", async () => {
      const privateAnswers = [
        [{ address: "10.0.0.8", family: 4 }],
        [{ address: "169.254.169.254", family: 4 }],
        [{ address: "192.168.0.1", family: 4 }],
        [{ address: "fd00::1", family: 6 }],
        [{ address: "::ffff:127.0.0.1", family: 6 }],
        // mixed answer set: one private answer poisons the whole set
        [
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
      ];
      for (const answers of privateAnswers) {
        await expect(
          fetchWithSsrfGuard({
            url: "https://rebind.attacker.example/audio.mp3",
            fetchImpl: noFetch,
            lookupFn: async () => answers,
          }),
        ).rejects.toBeInstanceOf(SsrfBlockedError);
      }
    });

    test("fails closed when DNS resolution errors or answers are empty", async () => {
      await expect(
        fetchWithSsrfGuard({
          url: "https://nxdomain.example/audio.mp3",
          fetchImpl: noFetch,
          lookupFn: async () => {
            throw new Error("ENOTFOUND");
          },
        }),
      ).rejects.toThrow();

      await expect(
        fetchWithSsrfGuard({
          url: "https://empty.example/audio.mp3",
          fetchImpl: noFetch,
          lookupFn: async () => [],
        }),
      ).rejects.toThrow();
    });

    test("screens DNS again on every redirect hop", async () => {
      const seenHosts: string[] = [];
      const fetchImpl = async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://a.example.com/start") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://evil.example.com/next" },
          });
        }
        return new Response("done", { status: 200 });
      };
      await expect(
        fetchWithSsrfGuard({
          url: "https://a.example.com/start",
          fetchImpl,
          lookupFn: async (hostname) => {
            seenHosts.push(hostname);
            // The redirect target rebinds to loopback — hop 2 must be blocked.
            if (hostname === "evil.example.com")
              return [{ address: "127.0.0.1", family: 4 }];
            return [{ address: "93.184.216.34", family: 4 }];
          },
        }),
      ).rejects.toBeInstanceOf(SsrfBlockedError);
      expect(seenHosts).toEqual(["a.example.com", "evil.example.com"]);
    });
  });
});
