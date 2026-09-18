/** Exercises SEO fetch boundaries and complete model output before artifact writes using controlled transport and repositories. */
import { describe, expect, mock, test } from "bun:test";

const admissionModule = await import("./organization-inference-admission");
mock.module("./organization-inference-admission", () => ({
  ...admissionModule,
  admitOrganizationInference: async () => ({
    markProviderDispatched: async () => undefined,
    settle: async () => undefined,
    settleUnknown: async () => undefined,
  }),
}));

let modelFinishReason = "stop";
const modelDraft = { title: "Complete title", description: "Complete description" };
const createArtifact = mock(async (row: Record<string, unknown>) => ({ id: "artifact-1", ...row }));
mock.module("ai", () => ({
  generateText: async () => ({ text: JSON.stringify(modelDraft), finishReason: modelFinishReason }),
}));
mock.module("../providers/language-model", () => ({ getLanguageModel: () => ({}) }));

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
    create: createArtifact,
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

describe("SEO model completion before artifact persistence", () => {
  test.each(["stop", "length", "content_filter", "error"])(
    "handles provider finish reason %s",
    async (finishReason) => {
      modelFinishReason = finishReason;
      createArtifact.mockClear();
      const request = {
        id: "req-model",
        organization_id: "org-1",
        type: "meta_generate",
        page_url: "https://example.com/page",
        locale: "en",
      };
      const operation = seoService.processRequest(
        request as Parameters<typeof seoService.processRequest>[0],
        {
          organizationId: "org-1",
          type: "meta_generate",
          operationContext: {
            organizationId: "org-1",
            userId: "user-1",
            apiKeyId: null,
            requestId: "req-model",
          },
        },
      );
      if (finishReason === "stop") {
        const result = await operation;
        expect(result.artifacts[0]?.data).toEqual(modelDraft);
        expect(createArtifact).toHaveBeenCalledTimes(1);
      } else {
        await expect(operation).rejects.toMatchObject({ code: "MODEL_OUTPUT_INCOMPLETE" });
        expect(createArtifact).not.toHaveBeenCalled();
      }
    },
  );
});
