/**
 * NotionClient contract tests against a deterministic, protocol-faithful fake
 * Notion API (real 2022-06-28 wire shapes served through an injected fetch).
 * Covers success, designed-empty, cursor pagination, expired/revoked auth,
 * rate limiting with Retry-After, malformed upstream data, upstream failure,
 * and write-path request shapes. No network access; the fake is a request
 * handler, not a mock of the client under test.
 */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { NOTION_API_VERSION, NotionClient } from "../client.js";
import type { NotionCredentialResolver } from "../types.js";

const resolver: NotionCredentialResolver = {
  getCredential: async () => ({ accessToken: "secret_test_token" }),
};

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeNotion(
  handler: (request: RecordedRequest) => {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
  }
): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ])
      ),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    const result = handler(request);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "Content-Type": "application/json", ...result.headers },
    });
  };
  return { fetchImpl, requests };
}

function page(id: string, title: string): Record<string, unknown> {
  return {
    object: "page",
    id,
    created_time: "2026-08-01T00:00:00.000Z",
    last_edited_time: "2026-08-02T00:00:00.000Z",
    archived: false,
    url: `https://www.notion.so/${title.replace(/\s/g, "-")}-${id.replace(/-/g, "")}`,
    parent: { type: "workspace", workspace: true },
    properties: {
      Name: {
        id: "title",
        type: "title",
        title: [{ type: "text", plain_text: title, text: { content: title } }],
      },
    },
  };
}

function client(fetchImpl: typeof fetch): NotionClient {
  return new NotionClient(resolver, { baseUrl: "https://notion.test", fetchImpl });
}

describe("NotionClient.search", () => {
  it("sends the bearer token, API version, and query, and maps results with deep links", async () => {
    const { fetchImpl, requests } = fakeNotion(() => ({
      status: 200,
      body: {
        object: "list",
        results: [page("11111111-2222-3333-4444-555555555555", "Q3 Plan")],
        next_cursor: null,
        has_more: false,
      },
    }));
    const result = await client(fetchImpl).search({ accountId: "acct", query: "plan" });

    expect(requests[0].url).toBe("https://notion.test/v1/search");
    expect(requests[0].headers.authorization).toBe("Bearer secret_test_token");
    expect(requests[0].headers["notion-version"]).toBe(NOTION_API_VERSION);
    expect((requests[0].body as { query: string }).query).toBe("plan");
    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toBe("Q3 Plan");
    expect(result.results[0].url).toContain("https://www.notion.so/");
    expect(result.results[0].parentType).toBe("workspace");
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("returns a designed-empty page when nothing matches", async () => {
    const { fetchImpl } = fakeNotion(() => ({
      status: 200,
      body: { object: "list", results: [], next_cursor: null, has_more: false },
    }));
    const result = await client(fetchImpl).search({ accountId: "acct", query: "nothing" });
    expect(result.results).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it("passes the cursor through and surfaces the next one", async () => {
    const { fetchImpl, requests } = fakeNotion((request) => {
      const cursor = (request.body as { start_cursor?: string }).start_cursor;
      return {
        status: 200,
        body: {
          object: "list",
          results: [page("11111111-2222-3333-4444-555555555555", cursor ? "Second" : "First")],
          next_cursor: cursor ? null : "cursor-2",
          has_more: !cursor,
        },
      };
    });
    const c = client(fetchImpl);
    const first = await c.search({ accountId: "acct", query: "q" });
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe("cursor-2");
    const second = await c.search({ accountId: "acct", query: "q", cursor: "cursor-2" });
    expect((requests[1].body as { start_cursor: string }).start_cursor).toBe("cursor-2");
    expect(second.results[0].title).toBe("Second");
    expect(second.hasMore).toBe(false);
  });

  it("maps 401 to NOTION_AUTH_EXPIRED", async () => {
    const { fetchImpl } = fakeNotion(() => ({
      status: 401,
      body: {
        object: "error",
        status: 401,
        code: "unauthorized",
        message: "API token is invalid.",
      },
    }));
    const error = await client(fetchImpl)
      .search({ accountId: "acct", query: "q" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ElizaError);
    expect((error as ElizaError).code).toBe("NOTION_AUTH_EXPIRED");
  });

  it("maps 429 to NOTION_RATE_LIMITED with the Retry-After delay", async () => {
    const { fetchImpl } = fakeNotion(() => ({
      status: 429,
      headers: { "Retry-After": "17" },
      body: { object: "error", status: 429, code: "rate_limited", message: "Rate limited." },
    }));
    const error = await client(fetchImpl)
      .search({ accountId: "acct", query: "q" })
      .catch((e: unknown) => e);
    expect((error as ElizaError).code).toBe("NOTION_RATE_LIMITED");
    expect((error as ElizaError).context?.retryAfterSeconds).toBe(17);
  });

  it("maps 5xx to NOTION_UPSTREAM_FAILURE", async () => {
    const { fetchImpl } = fakeNotion(() => ({
      status: 503,
      body: { object: "error", status: 503, code: "service_unavailable", message: "down" },
    }));
    const error = await client(fetchImpl)
      .search({ accountId: "acct", query: "q" })
      .catch((e: unknown) => e);
    expect((error as ElizaError).code).toBe("NOTION_UPSTREAM_FAILURE");
  });

  it("rejects a malformed success body missing the results array", async () => {
    const { fetchImpl } = fakeNotion(() => ({ status: 200, body: { object: "list" } }));
    const error = await client(fetchImpl)
      .search({ accountId: "acct", query: "q" })
      .catch((e: unknown) => e);
    expect((error as ElizaError).code).toBe("NOTION_MALFORMED_RESPONSE");
  });

  it("rejects an oversized declared success body before draining it", async () => {
    let cancelled = false;
    const fetchImpl: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{}"));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { "Content-Length": "4000001" } }
      );
    const error = await client(fetchImpl)
      .search({ accountId: "acct", query: "q" })
      .catch((e: unknown) => e);
    expect((error as ElizaError).code).toBe("NOTION_MALFORMED_RESPONSE");
    expect(cancelled).toBe(true);
  });

  it("rejects an object result missing its id or url", async () => {
    const { fetchImpl } = fakeNotion(() => ({
      status: 200,
      body: {
        object: "list",
        results: [{ object: "page", id: "x" }],
        next_cursor: null,
        has_more: false,
      },
    }));
    const error = await client(fetchImpl)
      .search({ accountId: "acct", query: "q" })
      .catch((e: unknown) => e);
    expect((error as ElizaError).code).toBe("NOTION_MALFORMED_RESPONSE");
  });
});

describe("NotionClient.getPageContent", () => {
  it("flattens paginated block children to plain text and reports unsupported types", async () => {
    const pageId = "11111111-2222-3333-4444-555555555555";
    const { fetchImpl, requests } = fakeNotion((request) => {
      if (request.url.includes("/v1/pages/")) {
        return { status: 200, body: page(pageId, "Doc") };
      }
      const isSecond = request.url.includes("start_cursor=blocks-2");
      return {
        status: 200,
        body: {
          object: "list",
          results: isSecond
            ? [
                {
                  object: "block",
                  type: "to_do",
                  to_do: { rich_text: [{ plain_text: "ship it" }], checked: true },
                },
                { object: "block", type: "image", image: {} },
              ]
            : [
                {
                  object: "block",
                  type: "heading_1",
                  heading_1: { rich_text: [{ plain_text: "Title" }] },
                },
                {
                  object: "block",
                  type: "paragraph",
                  paragraph: { rich_text: [{ plain_text: "Body text" }] },
                },
              ],
          next_cursor: isSecond ? null : "blocks-2",
          has_more: !isSecond,
        },
      };
    });
    const content = await client(fetchImpl).getPageContent({ accountId: "acct", pageId });
    expect(content.plainText).toBe("Title\nBody text\n[x] ship it");
    expect(content.unsupportedBlockTypes).toEqual(["image"]);
    expect(content.url).toContain("notion.so");
    // page read + two block pages
    expect(requests).toHaveLength(3);
  });

  it("follows block cursors until the provider reaches a terminal page", async () => {
    const pageId = "11111111-2222-3333-4444-555555555555";
    let blockPage = 0;
    const { fetchImpl, requests } = fakeNotion((request) => {
      if (request.url.includes("/v1/pages/")) {
        return { status: 200, body: page(pageId, "Long Doc") };
      }
      blockPage += 1;
      return {
        status: 200,
        body: {
          object: "list",
          results: [
            {
              object: "block",
              type: "paragraph",
              paragraph: { rich_text: [{ plain_text: `line-${blockPage}` }] },
            },
          ],
          next_cursor: blockPage <= 20 ? `cursor-${blockPage + 1}` : null,
          has_more: blockPage <= 20,
        },
      };
    });

    const content = await client(fetchImpl).getPageContent({ accountId: "acct", pageId });

    expect(content.plainText.split("\n")).toHaveLength(21);
    expect(content.plainText).toContain("line-21");
    expect(requests).toHaveLength(22);
  });

  it("rejects a repeated block continuation cursor", async () => {
    const pageId = "11111111-2222-3333-4444-555555555555";
    const { fetchImpl } = fakeNotion((request) => {
      if (request.url.includes("/v1/pages/")) {
        return { status: 200, body: page(pageId, "Looping Doc") };
      }
      return {
        status: 200,
        body: { object: "list", results: [], next_cursor: "same-cursor", has_more: true },
      };
    });

    const error = await client(fetchImpl)
      .getPageContent({ accountId: "acct", pageId })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ElizaError);
    expect((error as ElizaError).code).toBe("NOTION_MALFORMED_RESPONSE");
  });

  it("bounds endlessly advancing block cursors by one operation deadline", async () => {
    const pageId = "11111111-2222-3333-4444-555555555555";
    let clock = 0;
    let blockPage = 0;
    const { fetchImpl } = fakeNotion((request) => {
      if (request.url.includes("/v1/pages/")) {
        return { status: 200, body: page(pageId, "Endless Doc") };
      }
      blockPage += 1;
      clock += 1;
      return {
        status: 200,
        body: {
          object: "list",
          results: [],
          next_cursor: `unique-${blockPage}`,
          has_more: true,
        },
      };
    });
    const notion = new NotionClient(resolver, {
      baseUrl: "https://notion.test",
      fetchImpl,
      operationTimeoutMs: 3,
      now: () => clock,
    });

    const error = await notion
      .getPageContent({ accountId: "acct", pageId })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ElizaError);
    expect((error as ElizaError).code).toBe("NOTION_UPSTREAM_FAILURE");
    expect(blockPage).toBe(3);
  });
});

describe("NotionClient writes", () => {
  it("creates a page under a parent with title and paragraph children", async () => {
    const { fetchImpl, requests } = fakeNotion(() => ({
      status: 200,
      body: page("99999999-2222-3333-4444-555555555555", "New Page"),
    }));
    const created = await client(fetchImpl).createPage({
      accountId: "acct",
      parentPageId: "parent-1",
      title: "New Page",
      content: "line one\nline two",
    });
    const body = requests[0].body as {
      parent: { page_id: string };
      children: Array<{ paragraph: { rich_text: Array<{ text: { content: string } }> } }>;
    };
    expect(body.parent.page_id).toBe("parent-1");
    expect(body.children).toHaveLength(2);
    expect(body.children[1].paragraph.rich_text[0].text.content).toBe("line two");
    expect(created.title).toBe("New Page");
  });

  it("surfaces validation_error rejections as NOTION_INVALID_REQUEST", async () => {
    const { fetchImpl } = fakeNotion(() => ({
      status: 400,
      body: {
        object: "error",
        status: 400,
        code: "validation_error",
        message: "parent.page_id should be a valid uuid",
      },
    }));
    const error = await client(fetchImpl)
      .createPage({ accountId: "acct", parentPageId: "nope", title: "x" })
      .catch((e: unknown) => e);
    expect((error as ElizaError).code).toBe("NOTION_INVALID_REQUEST");
  });

  it("appends paragraphs with PATCH to block children", async () => {
    const { fetchImpl, requests } = fakeNotion(() => ({
      status: 200,
      body: { object: "list", results: [], next_cursor: null, has_more: false },
    }));
    await client(fetchImpl).appendToPage({ accountId: "acct", pageId: "p-1", content: "note" });
    expect(requests[0].method).toBe("PATCH");
    expect(requests[0].url).toBe("https://notion.test/v1/blocks/p-1/children");
  });

  it("maps 404 (not shared with the connection) to NOTION_NOT_FOUND", async () => {
    const { fetchImpl } = fakeNotion(() => ({
      status: 404,
      body: { object: "error", status: 404, code: "object_not_found", message: "Could not find" },
    }));
    const error = await client(fetchImpl)
      .getPage({ accountId: "acct", pageId: "missing" })
      .catch((e: unknown) => e);
    expect((error as ElizaError).code).toBe("NOTION_NOT_FOUND");
  });
});
