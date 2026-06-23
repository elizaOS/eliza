import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyFeedRequest = vi.fn<(...args: unknown[]) => Promise<Response>>();

vi.mock("./feed-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./feed-auth")>();
  return {
    ...actual,
    proxyFeedRequest: (...args: unknown[]) => proxyFeedRequest(...args),
    resolveFeedConfig: () => ({
      apiBaseUrl: "http://feed.test",
      agentId: "agent-1",
      agentSecret: "secret",
      stewardToken: undefined,
      runtime: null,
    }),
  };
});

const { handleAppRoutes } = await import("./routes");

function makeCtx(method: string, subpath: string, body?: unknown) {
  const pathname = `/api/apps/feed${subpath}`;
  return {
    method,
    pathname,
    url: new URL(`http://host${pathname}`),
    runtime: {},
    res: {},
    json: vi.fn(),
    error: vi.fn(),
    readJsonBody: async () => body ?? {},
    // biome-ignore lint/suspicious/noExplicitAny: synthetic test context
  } as any;
}

beforeEach(() => {
  proxyFeedRequest.mockReset();
  proxyFeedRequest.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
    // biome-ignore lint/suspicious/noExplicitAny: minimal Response stub
  } as any);
});

describe("handleAppRoutes — follow / friend proxy", () => {
  it("POST /users/:id/follow → POST /api/users/:id/follow", async () => {
    const handled = await handleAppRoutes(
      makeCtx("POST", "/users/u123/follow"),
    );
    expect(handled).toBe(true);
    const [, method, apiPath] = proxyFeedRequest.mock.calls[0] ?? [];
    expect(method).toBe("POST");
    expect(apiPath).toBe("/api/users/u123/follow");
  });

  it("DELETE /users/:id/follow → DELETE /api/users/:id/follow", async () => {
    const handled = await handleAppRoutes(
      makeCtx("DELETE", "/users/u123/follow"),
    );
    expect(handled).toBe(true);
    const [, method, apiPath] = proxyFeedRequest.mock.calls[0] ?? [];
    expect(method).toBe("DELETE");
    expect(apiPath).toBe("/api/users/u123/follow");
  });

  it("GET /users/:id/follow → GET /api/users/:id/follow (status)", async () => {
    const handled = await handleAppRoutes(makeCtx("GET", "/users/u123/follow"));
    expect(handled).toBe(true);
    const [, method, apiPath] = proxyFeedRequest.mock.calls[0] ?? [];
    expect(method).toBe("GET");
    expect(apiPath).toBe("/api/users/u123/follow");
  });

  it("passes a snowflake user id through to the backend path", async () => {
    await handleAppRoutes(makeCtx("POST", "/users/123456789012345678/follow"));
    const [, , apiPath] = proxyFeedRequest.mock.calls[0] ?? [];
    expect(apiPath).toBe("/api/users/123456789012345678/follow");
  });
});

describe("handleAppRoutes — explicit DM creation", () => {
  it("POST /chats/dm → POST /api/chats/dm", async () => {
    const handled = await handleAppRoutes(
      makeCtx("POST", "/chats/dm", { userId: "u123" }),
    );
    expect(handled).toBe(true);
    const [, method, apiPath, body] = proxyFeedRequest.mock.calls[0] ?? [];
    expect(method).toBe("POST");
    expect(apiPath).toBe("/api/chats/dm");
    expect(body).toEqual({ userId: "u123" });
  });
});
