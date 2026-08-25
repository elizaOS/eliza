/**
 * Unit tests for NotionService lifecycle and client delegation.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { NotionService } from "../service.js";
import type { NotionCredentialResolver } from "../types.js";

const resolver: NotionCredentialResolver = {
  getCredential: async () => ({ accessToken: "secret_service_test_token" }),
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

describe("NotionService", () => {
  it("initializes and reports capability description", () => {
    const service = new NotionService(undefined, { credentialResolver: resolver });
    expect(service.capabilityDescription).toContain("Notion workspace service");
  });

  it("starts and stops service lifecycle", async () => {
    const runtime = {} as unknown as IAgentRuntime;
    const service = await NotionService.start(runtime);
    expect(service).toBeInstanceOf(NotionService);
    await expect(service.stop()).resolves.toBeUndefined();
  });

  it("updates credential resolver via setCredentialResolver", async () => {
    const { fetchImpl, requests } = fakeNotion(() => ({
      status: 200,
      body: { object: "list", results: [], has_more: false, next_cursor: null },
    }));

    const service = new NotionService(undefined, {
      credentialResolver: resolver,
      clientOptions: { baseUrl: "https://notion.test", fetchImpl },
    });

    const updatedResolver: NotionCredentialResolver = {
      getCredential: async () => ({ accessToken: "updated_token_456" }),
    };

    service.setCredentialResolver(updatedResolver);

    await service.search({ accountId: "default", query: "roadmap" });
    expect(requests[0].headers.authorization).toBe("Bearer updated_token_456");
  });

  it("delegates search, getPage, getPageContent, createPage, and appendToPage to client", async () => {
    const samplePage = page("page-123", "Project Plan");
    const { fetchImpl } = fakeNotion((req) => {
      if (req.method === "POST" && req.url.endsWith("/v1/search")) {
        return {
          status: 200,
          body: { object: "list", results: [samplePage], has_more: false, next_cursor: null },
        };
      }
      if (req.method === "GET" && req.url.includes("/v1/pages/page-123")) {
        return {
          status: 200,
          body: samplePage,
        };
      }
      if (req.method === "GET" && req.url.includes("/v1/blocks/page-123/children")) {
        return {
          status: 200,
          body: {
            object: "list",
            results: [
              {
                object: "block",
                type: "paragraph",
                paragraph: {
                  rich_text: [{ plain_text: "Line 1" }],
                },
              },
            ],
            has_more: false,
            next_cursor: null,
          },
        };
      }
      if (req.method === "POST" && req.url.endsWith("/v1/pages")) {
        return {
          status: 200,
          body: page("page-456", "New Page"),
        };
      }
      if (req.method === "PATCH" && req.url.includes("/children")) {
        return {
          status: 200,
          body: { object: "list", results: [] },
        };
      }
      return { status: 404, body: {} };
    });

    const service = new NotionService(undefined, {
      credentialResolver: resolver,
      clientOptions: { baseUrl: "https://notion.test", fetchImpl },
    });

    const searchRes = await service.search({ accountId: "default", query: "Project" });
    expect(searchRes.results).toHaveLength(1);
    expect(searchRes.results[0].title).toBe("Project Plan");

    const pageRes = await service.getPage({ accountId: "default", pageId: "page-123" });
    expect(pageRes.id).toBe("page-123");
    expect(pageRes.title).toBe("Project Plan");

    const contentRes = await service.getPageContent({ accountId: "default", pageId: "page-123" });
    expect(contentRes.plainText).toBe("Line 1");

    const createRes = await service.createPage({
      accountId: "default",
      parentPageId: "page-123",
      title: "New Page",
      content: "Content",
    });
    expect(createRes.id).toBe("page-456");

    await expect(
      service.appendToPage({
        accountId: "default",
        pageId: "page-123",
        content: "Appended",
      })
    ).resolves.toBeUndefined();
  });
});
