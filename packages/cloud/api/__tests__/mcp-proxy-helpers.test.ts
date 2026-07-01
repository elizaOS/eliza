/**
 * Unit tests for pure helpers in `mcp/proxy/[mcpId]/route.ts`.
 *
 * These exercise the request-shape branching that the route uses to decide
 * how to bill a tool call (toolNameFromRpcBody) and to safely parse the
 * incoming MCP-RPC body (parseJsonBody). They run without a live Worker,
 * Postgres, or Redis — the helpers are pure.
 */

import { describe, expect, test } from "bun:test";

import {
  type McpProxyJson,
  parseJsonBody,
  resolveMcpProxyView,
  toolNameFromRpcBody,
} from "../mcp/proxy/[mcpId]/route";

describe("toolNameFromRpcBody", () => {
  test("returns the tool name for a valid tools/call body", () => {
    const body: McpProxyJson = {
      method: "tools/call",
      params: { name: "search", arguments: { q: "hi" } },
    };
    expect(toolNameFromRpcBody(body)).toBe("search");
  });

  test("returns 'unknown' when method is not tools/call", () => {
    const body: McpProxyJson = {
      method: "initialize",
      params: { name: "search" },
    };
    expect(toolNameFromRpcBody(body)).toBe("unknown");
  });

  test("returns 'unknown' when body is not an object", () => {
    expect(toolNameFromRpcBody(null)).toBe("unknown");
    expect(toolNameFromRpcBody([])).toBe("unknown");
    expect(toolNameFromRpcBody("hello")).toBe("unknown");
    expect(toolNameFromRpcBody(42)).toBe("unknown");
    expect(toolNameFromRpcBody(true)).toBe("unknown");
  });

  test("returns 'unknown' when params is missing or wrong shape", () => {
    expect(toolNameFromRpcBody({ method: "tools/call" })).toBe("unknown");
    expect(toolNameFromRpcBody({ method: "tools/call", params: null })).toBe(
      "unknown",
    );
    expect(toolNameFromRpcBody({ method: "tools/call", params: [] })).toBe(
      "unknown",
    );
    expect(toolNameFromRpcBody({ method: "tools/call", params: "bad" })).toBe(
      "unknown",
    );
  });

  test("returns 'unknown' when params.name is missing or empty", () => {
    expect(toolNameFromRpcBody({ method: "tools/call", params: {} })).toBe(
      "unknown",
    );
    expect(
      toolNameFromRpcBody({ method: "tools/call", params: { name: "" } }),
    ).toBe("unknown");
    expect(
      toolNameFromRpcBody({ method: "tools/call", params: { name: 7 } }),
    ).toBe("unknown");
  });
});

describe("parseJsonBody", () => {
  test("returns {} when content-type is not JSON", async () => {
    const req = new Request("https://example.com", {
      method: "POST",
      body: "ignored",
      headers: { "content-type": "text/plain" },
    });
    expect(await parseJsonBody(req)).toEqual({});
  });

  test("returns {} when content-type is missing", async () => {
    const req = new Request("https://example.com", {
      method: "POST",
      body: '{"a":1}',
    });
    expect(await parseJsonBody(req)).toEqual({});
  });

  test("returns {} for empty JSON body", async () => {
    const req = new Request("https://example.com", {
      method: "POST",
      body: "   ",
      headers: { "content-type": "application/json" },
    });
    expect(await parseJsonBody(req)).toEqual({});
  });

  test("parses a valid JSON-RPC body", async () => {
    const req = new Request("https://example.com", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "do_thing", arguments: { foo: "bar" } },
        id: 1,
      }),
      headers: { "content-type": "application/json" },
    });
    const parsed = await parseJsonBody(req);
    expect(toolNameFromRpcBody(parsed)).toBe("do_thing");
  });

  test("throws on malformed JSON when content-type claims JSON", async () => {
    const req = new Request("https://example.com", {
      method: "POST",
      body: "{not json}",
      headers: { "content-type": "application/json" },
    });
    await expect(parseJsonBody(req)).rejects.toThrow();
  });
});

describe("resolveMcpProxyView (cross-org access gate)", () => {
  const OWNER = "org-owner";
  const OTHER = "org-other";

  test("owner of a non-public MCP gets full access", () => {
    const view = resolveMcpProxyView({
      mcpOrganizationId: OWNER,
      mcpIsPublic: false,
      viewerOrganizationId: OWNER,
    });
    expect(view).toEqual({ allowed: true, isOwner: true });
  });

  test("non-owner is denied a non-public MCP (no cross-org disclosure)", () => {
    const view = resolveMcpProxyView({
      mcpOrganizationId: OWNER,
      mcpIsPublic: false,
      viewerOrganizationId: OTHER,
    });
    expect(view).toEqual({ allowed: false, isOwner: false });
  });

  test("anonymous caller is denied a non-public MCP", () => {
    const view = resolveMcpProxyView({
      mcpOrganizationId: OWNER,
      mcpIsPublic: false,
      viewerOrganizationId: null,
    });
    expect(view).toEqual({ allowed: false, isOwner: false });
  });

  test("non-owner may view a public MCP but is not treated as owner", () => {
    const view = resolveMcpProxyView({
      mcpOrganizationId: OWNER,
      mcpIsPublic: true,
      viewerOrganizationId: OTHER,
    });
    expect(view).toEqual({ allowed: true, isOwner: false });
  });

  test("anonymous caller may view a public MCP (catalog browse)", () => {
    const view = resolveMcpProxyView({
      mcpOrganizationId: OWNER,
      mcpIsPublic: true,
      viewerOrganizationId: undefined,
    });
    expect(view).toEqual({ allowed: true, isOwner: false });
  });

  test("empty-string viewer org is never treated as owner", () => {
    const view = resolveMcpProxyView({
      mcpOrganizationId: "",
      mcpIsPublic: false,
      viewerOrganizationId: "",
    });
    expect(view).toEqual({ allowed: false, isOwner: false });
  });
});
