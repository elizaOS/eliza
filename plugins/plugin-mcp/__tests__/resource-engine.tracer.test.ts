/**
 * Exercises the public stateless MCP resource engine against a deterministic
 * external-client adapter. The harness verifies authenticated discovery,
 * exact tool dispatch, operation-local teardown, and stale attachment safety.
 */

import { UnauthorizedError } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { createMcpResourceEngine, type McpResourceOperationFactory } from "../src/resource-engine";

describe("MCP resource engine", () => {
  it("attaches an authenticated stateless resource, discovers, calls exactly, then rejects the stale ref", async () => {
    const openedOperations: Array<{
      accessToken?: string;
      closed: boolean;
      purpose: "discover" | "call-tool";
    }> = [];
    const calls: Array<{
      name: string;
      arguments?: Readonly<Record<string, unknown>>;
    }> = [];
    const openOperation: McpResourceOperationFactory = vi.fn(async (request) => {
      const opened = {
        accessToken: request.accessToken,
        closed: false,
        purpose: request.purpose,
      };
      openedOperations.push(opened);
      return {
        discover: async () => ({
          server: {
            info: { name: "gmail", version: "preview" },
            capabilities: { tools: {} },
          },
          tools: [
            {
              name: "search_threads",
              description: "Search Gmail threads",
              inputSchema: { type: "object" },
            },
          ],
          resources: [],
          resourceTemplates: [],
        }),
        callTool: async (call) => {
          calls.push(call);
          return { content: [{ type: "text", text: "thread-1" }] };
        },
        close: async () => {
          opened.closed = true;
        },
      };
    });
    const getAccessToken = vi.fn(async () => ({ accessToken: "access-1" }));
    const engine = createMcpResourceEngine({ openOperation });
    const ref = await engine.attach({
      key: "google:acct-1:gmail",
      endpoint: "https://gmailmcp.googleapis.com/mcp/v1",
      auth: { getAccessToken },
    });

    await expect(engine.discover(ref)).resolves.toMatchObject({
      tools: [{ name: "search_threads" }],
    });
    await expect(
      engine.callTool(ref, {
        name: "search_threads",
        arguments: { query: "from:alice@example.com" },
      })
    ).resolves.toEqual({ content: [{ type: "text", text: "thread-1" }] });

    expect(calls).toEqual([
      {
        name: "search_threads",
        arguments: { query: "from:alice@example.com" },
      },
    ]);
    expect(openedOperations).toEqual([
      { accessToken: "access-1", closed: true, purpose: "discover" },
      { accessToken: "access-1", closed: true, purpose: "call-tool" },
    ]);
    expect(getAccessToken).toHaveBeenCalledTimes(2);

    await expect(engine.detach(ref)).resolves.toBe(true);
    await expect(
      engine.callTool(ref, { name: "search_threads", arguments: {} })
    ).rejects.toMatchObject({ code: "MCP_RESOURCE_DETACHED" });
    expect(openOperation).toHaveBeenCalledTimes(2);
  });

  it("invalidates a rejected access token and retries once with a fresh token", async () => {
    const openedTokens: Array<string | undefined> = [];
    const openOperation: McpResourceOperationFactory = vi.fn(async (request) => {
      openedTokens.push(request.accessToken);
      return {
        discover: async () => ({
          server: { capabilities: {} },
          tools: [],
          resources: [],
          resourceTemplates: [],
        }),
        callTool: async () => {
          if (request.accessToken === "expired-token") {
            throw new UnauthorizedError();
          }
          return { content: [{ type: "text", text: "ok" }] };
        },
        close: async () => undefined,
      };
    });
    const getAccessToken = vi
      .fn()
      .mockResolvedValueOnce({ accessToken: "expired-token" })
      .mockResolvedValueOnce({ accessToken: "fresh-token" });
    const invalidateAccessToken = vi.fn(async () => undefined);
    const engine = createMcpResourceEngine({ openOperation });
    const ref = await engine.attach({
      key: "google:acct-1:calendar",
      endpoint: "https://calendarmcp.googleapis.com/mcp/v1",
      auth: { getAccessToken, invalidateAccessToken },
    });

    await expect(engine.callTool(ref, { name: "list_events" })).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
    });

    expect(openedTokens).toEqual(["expired-token", "fresh-token"]);
    expect(invalidateAccessToken).toHaveBeenCalledWith({
      key: ref.key,
      endpoint: new URL("https://calendarmcp.googleapis.com/mcp/v1"),
      reason: "unauthorized",
    });
    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });

  it("revokes new work immediately and drains an in-flight exact call before detach resolves", async () => {
    let releaseCall = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    const openOperation: McpResourceOperationFactory = vi.fn(async () => ({
      discover: async () => ({
        server: { capabilities: {} },
        tools: [],
        resources: [],
        resourceTemplates: [],
      }),
      callTool: async () => {
        await gate;
        return { content: [{ type: "text", text: "accepted" }] };
      },
      close: async () => undefined,
    }));
    const engine = createMcpResourceEngine({ openOperation });
    const ref = await engine.attach({
      key: "google:acct-1:gmail",
      endpoint: "https://gmailmcp.googleapis.com/mcp/v1",
    });

    const call = engine.callTool(ref, { name: "search_threads" });
    await vi.waitFor(() => expect(openOperation).toHaveBeenCalledTimes(1));
    let detached = false;
    const detach = engine.detach(ref).then((result) => {
      detached = true;
      return result;
    });
    await expect(engine.callTool(ref, { name: "search_threads" })).rejects.toMatchObject({
      code: "MCP_RESOURCE_DETACHED",
    });
    expect(detached).toBe(false);

    releaseCall();
    await expect(call).resolves.toMatchObject({ content: [{ text: "accepted" }] });
    await expect(detach).resolves.toBe(true);
  });

  it("returns a typed endpoint error before attachment", async () => {
    const engine = createMcpResourceEngine();
    await expect(engine.attach({ key: "invalid", endpoint: "not a URL" })).rejects.toMatchObject({
      code: "MCP_RESOURCE_ENDPOINT_INVALID",
    });
  });

  it("rejects an empty broker token before opening a transport", async () => {
    const openOperation: McpResourceOperationFactory = vi.fn(async () => {
      throw new Error("unexpected transport");
    });
    const engine = createMcpResourceEngine({ openOperation });
    const ref = await engine.attach({
      key: "google:acct-1:gmail",
      endpoint: "https://gmailmcp.googleapis.com/mcp/v1",
      auth: { getAccessToken: async () => ({ accessToken: "  " }) },
    });
    await expect(engine.discover(ref)).rejects.toMatchObject({
      code: "MCP_RESOURCE_ACCESS_TOKEN_INVALID",
    });
    expect(openOperation).not.toHaveBeenCalled();
  });
});
