// Pins the bounded-SSRF contract of seoFetch: every SEO provider hop goes
// through the file's SSRF-safe wrapper AND fails closed at the hop timeout
// (a caller-provided abort signal wins). The health-check hop is included:
// its URL is caller-supplied, so it is the one hop an untrusted input aims.
import { describe, expect, mock, test } from "bun:test";

let seenInit: RequestInit | undefined;
let seenUrl: string | undefined;
let respond: () => Promise<Response> = async () => new Response("{}", { status: 200 });

mock.module("../security/safe-fetch", () => ({
  safeFetch: (rawUrl: string, init: RequestInit = {}) => {
    seenUrl = rawUrl;
    seenInit = init;
    return respond();
  },
}));

mock.module("../../db/repositories/seo-requests", () => ({
  seoRequestsRepository: {
    findByIdempotency: async () => null,
    create: async (row: Record<string, unknown>) => row,
    findById: async () => null,
    updateStatus: async () => undefined,
  },
}));

mock.module("../../db/repositories/seo-artifacts", () => ({
  seoArtifactsRepository: {
    create: async (row: Record<string, unknown>) => ({ id: "artifact-1", ...row }),
    listByRequest: async () => [],
  },
}));

mock.module("../../db/repositories/seo-provider-calls", () => ({
  seoProviderCallsRepository: {
    create: async (row: Record<string, unknown>) => ({ id: "call-1", ...row }),
    updateStatus: async () => undefined,
    listByRequest: async () => [],
  },
}));

// Keep every other export of the db client intact (other modules re-export
// from it); only the drizzle handle is stubbed so the completion write is a
// no-op instead of a real connection.
const dbClient = await import("../../db/client");
mock.module("../../db/client", () => ({
  ...dbClient,
  db: { update: () => ({ set: () => ({ where: async () => undefined }) }) },
}));

const { seoFetch, seoService } = await import("./seo");

type HealthArtifact = {
  ok: boolean;
  status: number;
  robots: boolean;
  canonical?: string;
};

async function runHealthCheckThroughService(pageUrl: string) {
  const request = {
    id: "req-1",
    organization_id: "org-1",
    type: "health_check",
    page_url: pageUrl,
  };
  return await seoService.processRequest(
    request as unknown as Parameters<typeof seoService.processRequest>[0],
    {} as Parameters<typeof seoService.processRequest>[1],
  );
}

describe("seoFetch — SSRF-safe hops that fail closed and keep caller signals", () => {
  test("routes through safeFetch with a default hop timeout signal", async () => {
    await seoFetch("https://api.dataforseo.com/v3/…");
    expect(seenUrl).toBe("https://api.dataforseo.com/v3/…");
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
  });

  test("composes a caller-provided abort signal with the hop deadline", async () => {
    const controller = new AbortController();
    await seoFetch("https://api.indexnow.org/indexnow", {
      signal: controller.signal,
    });
    // The wrapper owns the deadline, so safeFetch receives a composition of the
    // caller signal and that deadline — never the caller's object verbatim.
    // Asserting identity here would pin the behavior that lets a caller signal
    // which never fires silently defeat the bound.
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
    expect(seenInit?.signal).not.toBe(controller.signal);
  });

  test("aborts when the caller cancels", async () => {
    const controller = new AbortController();
    await seoFetch("https://api.indexnow.org/indexnow", {
      signal: controller.signal,
    });
    const composed = seenInit?.signal;
    expect(composed?.aborted).toBe(false);
    controller.abort();
    expect(composed?.aborted).toBe(true);
  });
});

describe("health_check — the caller-supplied hop is bounded too", () => {
  test("bounds the caller-supplied page URL with the hop deadline", async () => {
    seenInit = undefined;
    seenUrl = undefined;
    respond = async () => new Response("<html></html>", { status: 200 });

    await runHealthCheckThroughService("https://example.com/landing");

    expect(seenUrl).toBe("https://example.com/landing");
    // Without the deadline this hop reaches safeFetch with no signal at all,
    // and a host that accepts the connection but never answers pins the SEO
    // worker forever. safeFetch screens the address; only this bounds the wait.
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
    expect(seenInit?.signal?.aborted).toBe(false);
    // The hop still refuses redirects, exactly as before.
    expect(seenInit?.redirect).toBe("error");
    expect(seenInit?.method).toBe("GET");
  });

  test("a slow but finite health check still succeeds", async () => {
    respond = async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return new Response(
        '<html><head><link rel="canonical" href="https://example.com/canonical"></head></html>',
        { status: 200 },
      );
    };

    const result = await runHealthCheckThroughService("https://example.com/slow");
    const report = result.artifacts[0]?.data as HealthArtifact;

    // Over-rejection guard: the deadline must not turn a merely slow origin
    // into a failure, and the parsed report must survive unchanged.
    expect(report.ok).toBe(true);
    expect(report.status).toBe(200);
    expect(report.robots).toBe(true);
    expect(report.canonical).toBe("https://example.com/canonical");
  });

  test("surfaces a noindex page as a failed robots check", async () => {
    respond = async () =>
      new Response('<html><head><meta name="robots" content="noindex"></head></html>', {
        status: 200,
      });

    const result = await runHealthCheckThroughService("https://example.com/noindex");
    const report = result.artifacts[0]?.data as HealthArtifact;

    expect(report.robots).toBe(false);
  });
});
