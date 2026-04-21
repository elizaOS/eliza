/**
 * MIXED FETCH-SHIM + MIXIN-SHAPE TEST — this file is two different things
 * stitched together. Read before you trust a green run.
 *
 * Part 1 (genuine integration against the real x-reader code):
 *   - `readXDms`, `pullXFeed`, and `searchX` describe blocks stub the global
 *     `fetch` and assert that the real x-reader code under test:
 *       - hits the correct Twitter API v2 URL (`/2/.../dm_events`, etc.)
 *       - sends an OAuth 1.0a `Authorization` header with `oauth_signature=`
 *       - translates 401 → `XReadError{category: "auth"}` and 429 +
 *         `Retry-After` → `XReadError{category: "rate_limit",
 *         retryAfterSeconds}`
 *     These are real assertions against real code and are the valuable
 *     tests in this file.
 *
 * Part 2 (shape-only — LARP caveat):
 *   - `describe("withXRead mixin")` composes the mixin onto a StubBase and
 *     ONLY asserts `typeof svc.syncXDms === "function"` (and three sibling
 *     typeof checks). It does NOT invoke any mixin method and therefore does
 *     NOT exercise sync logic, pagination cursors, dedup against the
 *     repository, or the OAuth plumbing.
 *   - `describe("xReadAction.validate")` replaces `LifeOpsService` with a
 *     `vi.spyOn(...).mockImplementation` stub that only exposes
 *     `getXConnectorStatus`. It verifies the validate-gate returns false
 *     when the connector reports `connected: false`, not that validate
 *     ever actually consults a real service.
 *
 * Regressions that would slip past the shape-only parts:
 *   - A mixin method whose signature exists but whose body throws.
 *   - A repository `upsertXDm` call that silently drops fields on real rows.
 *   - `xReadAction.validate` returning true when the connector reports
 *     connected but inbound sync is disabled.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  pullXFeed,
  readXDms,
  searchX,
  XReadError,
  type XReaderCredentials,
} from "../src/lifeops/x-reader.js";
import { withXRead } from "../src/lifeops/service-mixin-x-read.js";
import * as serviceModule from "../src/lifeops/service.js";
import { xReadAction } from "../src/actions/x-read.js";

const ORIGINAL_FETCH = global.fetch;
const SAME_ID = "00000000-0000-0000-0000-000000000001";

const CREDS: XReaderCredentials = {
  apiKey: "ak",
  apiSecret: "as",
  accessToken: "at",
  accessTokenSecret: "ats",
  userId: "user-42",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("readXDms", () => {
  test("hits Twitter API v2 dm_events endpoint with OAuth Authorization header", async () => {
    let capturedUrl = "";
    let capturedAuth = "";
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      const headers = init?.headers as Record<string, string> | undefined;
      capturedAuth = headers?.Authorization ?? "";
      return jsonResponse({ data: [], meta: {} });
    }) as unknown as typeof fetch;

    const page = await readXDms(CREDS, { limit: 10 });
    expect(capturedUrl).toContain("/2/");
    expect(capturedUrl).toContain("/dm_events");
    expect(capturedAuth.startsWith("OAuth ")).toBe(true);
    expect(capturedAuth).toContain("oauth_signature=");
    expect(page.items).toEqual([]);
  });
});

describe("pullXFeed", () => {
  test('"home_timeline" hits /2/users/{id}/timelines/reverse_chronological', async () => {
    let capturedUrl = "";
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return jsonResponse({ data: [] });
    }) as unknown as typeof fetch;

    await pullXFeed(CREDS, "home_timeline");
    expect(capturedUrl).toContain(
      "/2/users/user-42/timelines/reverse_chronological",
    );
  });

  test('"mentions" hits /2/users/{id}/mentions', async () => {
    let capturedUrl = "";
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return jsonResponse({ data: [] });
    }) as unknown as typeof fetch;

    await pullXFeed(CREDS, "mentions");
    expect(capturedUrl).toContain("/2/users/user-42/mentions");
  });
});

describe("searchX", () => {
  test("hits /2/tweets/search/recent with query param", async () => {
    let capturedUrl = "";
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return jsonResponse({ data: [] });
    }) as unknown as typeof fetch;

    await searchX(CREDS, "elizaOS");
    expect(capturedUrl).toContain("/2/tweets/search/recent");
    expect(capturedUrl).toContain("query=elizaOS");
  });
});

describe("XReadError categorization", () => {
  test('throws auth error on 401', async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse({ errors: [{ detail: "Unauthorized" }] }, { status: 401 }),
    ) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await readXDms(CREDS);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(XReadError);
    expect((caught as XReadError).category).toBe("auth");
    expect((caught as XReadError).status).toBe(401);
  });

  test("throws rate_limit error on 429 with Retry-After header", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ errors: [{ detail: "Too Many" }] }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "42",
        },
      }),
    ) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await readXDms(CREDS);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(XReadError);
    expect((caught as XReadError).category).toBe("rate_limit");
    expect((caught as XReadError).retryAfterSeconds).toBe(42);
  });
});

describe("withXRead mixin", () => {
  test("instantiates against a stub base", () => {
    class StubBase {
      runtime = { agentId: SAME_ID, logger: console };
      ownerEntityId = null;
      agentId() {
        return SAME_ID;
      }
      async requireXGrant() {
        return undefined;
      }
      repository = {
        upsertXDm: vi.fn(),
        upsertXFeedItem: vi.fn(),
        upsertXSyncState: vi.fn(),
        listXDms: vi.fn(async () => []),
        listXFeedItems: vi.fn(async () => []),
      };
    }
    const Composed = withXRead(StubBase as never);
    // biome-ignore lint/suspicious/noExplicitAny: mixin stub
    const svc = new (Composed as any)();
    expect(typeof svc.syncXDms).toBe("function");
    expect(typeof svc.syncXFeed).toBe("function");
    expect(typeof svc.searchXPosts).toBe("function");
    expect(typeof svc.readXInboundDms).toBe("function");
  });
});

describe("xReadAction.validate", () => {
  test("returns false when LifeOpsService.getXConnectorStatus reports not connected", async () => {
    vi.spyOn(serviceModule, "LifeOpsService").mockImplementation(
      function (this: Record<string, unknown>) {
        this.getXConnectorStatus = vi.fn(async () => ({
          provider: "x",
          connected: false,
          inbound: false,
          lastCheckedAt: new Date().toISOString(),
        }));
      } as unknown as typeof serviceModule.LifeOpsService,
    );

    const runtime = {
      agentId: SAME_ID,
      character: { settings: {} },
    } as unknown as Parameters<NonNullable<typeof xReadAction.validate>>[0];
    const message = {
      entityId: SAME_ID,
      content: { text: "x" },
    } as unknown as Parameters<NonNullable<typeof xReadAction.validate>>[1];

    const ok = await xReadAction.validate!(runtime, message);
    expect(ok).toBe(false);
  });
});
