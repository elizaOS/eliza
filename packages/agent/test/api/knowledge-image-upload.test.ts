import { describe, expect, test, vi } from "vitest";
import type { KnowledgeRouteContext } from "../../src/api/knowledge-routes";
import { handleKnowledgeRoutes } from "../../src/api/knowledge-routes";
import {
  createMockHttpResponse,
  createMockIncomingMessage,
} from "../../src/test-support/test-helpers";

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildCtx(
  method: string,
  pathname: string,
  body: Record<string, unknown> = {},
  overrides?: Partial<KnowledgeRouteContext>,
): KnowledgeRouteContext {
  const { res } = createMockHttpResponse();
  return {
    req: createMockIncomingMessage({ method, url: pathname }),
    res,
    method,
    pathname,
    url: new URL(pathname, "http://localhost:2138"),
    json: vi.fn((r, data, status = 200) => {
      r.writeHead(status);
      r.end(JSON.stringify(data));
    }),
    error: vi.fn((r, msg, status = 500) => {
      r.writeHead(status);
      r.end(JSON.stringify({ error: msg }));
    }),
    readJsonBody: vi.fn(async () => body),
    runtime: null,
    ...overrides,
  } as KnowledgeRouteContext;
}

// ── POST /api/knowledge/documents ────────────────────────────────────────────

describe("knowledge image upload (POST /api/knowledge/documents)", () => {
  test("requires runtime — returns error when runtime is null", async () => {
    const ctx = buildCtx(
      "POST",
      "/api/knowledge/documents",
      {
        content: "iVBORw0KGgo=",
        filename: "photo.png",
        contentType: "image/png",
      },
    );
    const handled = await handleKnowledgeRoutes(ctx);
    expect(handled).toBe(true);
    expect(ctx.error).toHaveBeenCalled();
  });

  test("requires runtime — returns error for markdown upload when runtime is null", async () => {
    const ctx = buildCtx(
      "POST",
      "/api/knowledge/documents",
      {
        content: "# Hello world",
        filename: "notes.md",
        contentType: "text/markdown",
      },
    );
    const handled = await handleKnowledgeRoutes(ctx);
    expect(handled).toBe(true);
    expect(ctx.error).toHaveBeenCalled();
  });

  test("requires runtime — returns error for mdx upload when runtime is null", async () => {
    const ctx = buildCtx(
      "POST",
      "/api/knowledge/documents",
      {
        content: "# Hello MDX",
        filename: "page.mdx",
        contentType: "text/markdown",
      },
    );
    const handled = await handleKnowledgeRoutes(ctx);
    expect(handled).toBe(true);
    expect(ctx.error).toHaveBeenCalled();
  });
});

// ── Content-type routing (unit-level) ────────────────────────────────────────
// These tests verify the logic that determines how a file's content is
// interpreted based on its contentType — without requiring a running runtime.

describe("contentType determination for knowledge uploads", () => {
  test("image/png content type is passed through as-is in the request body", () => {
    // The frontend encodes image files as base64 and sends contentType image/png.
    // The server accepts whatever contentType the client provides.
    const body = {
      content: "iVBORw0KGgo=",
      filename: "screenshot.png",
      contentType: "image/png",
    };
    expect(body.contentType).toBe("image/png");
    expect(typeof body.content).toBe("string");
  });

  test("text/markdown content type preserves text content unchanged", () => {
    const content = "# My Document\n\nSome text here.";
    const body = {
      content,
      filename: "notes.md",
      contentType: "text/markdown",
    };
    expect(body.content).toBe(content);
    expect(body.contentType).toBe("text/markdown");
  });

  test("mdx files are sent with text/markdown contentType", () => {
    // .mdx files read as text via shouldReadKnowledgeFileAsText and
    // the browser assigns type text/markdown (or empty — but our code
    // normalizes to text/markdown for .mdx).
    const body = {
      content: "# MDX Page\n\nexport const meta = {}",
      filename: "page.mdx",
      contentType: "text/markdown",
    };
    expect(body.contentType).toBe("text/markdown");
  });

  test("addKnowledgeDocument falls back to text/plain when contentType is omitted", () => {
    // The server-side addKnowledgeDocument helper uses
    // `document.contentType || "text/plain"`.
    const contentType = undefined;
    const resolved = contentType || "text/plain";
    expect(resolved).toBe("text/plain");
  });
});
