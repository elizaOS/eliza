import {
  type IAgentRuntime,
  type Memory,
  type SearchCategoryEnumerationOptions,
  type SearchCategoryLookupOptions,
  type SearchCategoryRegistration,
  SearchCategoryRegistryError,
  ServiceType,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { webSearchPlugin } from "../../../../plugins/plugin-web-search/src/index.ts";
import { searchAction } from "./web-search.js";

type TestRuntime = IAgentRuntime & {
  __services: Map<string, unknown>;
  __categories: Map<string, SearchCategoryRegistration>;
};

function cloneCategory(
  registration: SearchCategoryRegistration,
): SearchCategoryRegistration {
  return {
    ...registration,
    filters: registration.filters?.map((filter) => ({
      ...filter,
      options: filter.options?.map((option) => ({ ...option })),
    })),
  };
}

function createRuntime(): TestRuntime {
  const services = new Map<string, unknown>();
  const categories = new Map<string, SearchCategoryRegistration>();

  const runtime = {
    agentId: "agent-id",
    __services: services,
    __categories: categories,
    getSetting: vi.fn(),
    getService: vi.fn(
      (serviceType: string) => services.get(serviceType) ?? null,
    ),
    registerSearchCategory: vi.fn(
      (registration: SearchCategoryRegistration) => {
        categories.set(
          registration.category.trim().toLowerCase(),
          cloneCategory(registration),
        );
      },
    ),
    getSearchCategories: vi.fn(
      (options: SearchCategoryEnumerationOptions = {}) => {
        return Array.from(categories.values())
          .filter((registration) =>
            options.includeDisabled ? true : registration.enabled !== false,
          )
          .map(cloneCategory);
      },
    ),
    getSearchCategory: vi.fn(
      (category: string, options: SearchCategoryLookupOptions = {}) => {
        const registration = categories.get(category.trim().toLowerCase());
        if (!registration) {
          throw new SearchCategoryRegistryError(
            "SEARCH_CATEGORY_NOT_FOUND",
            category,
            `No search category registered for category: ${category}`,
          );
        }
        if (!options.includeDisabled && registration.enabled === false) {
          throw new SearchCategoryRegistryError(
            "SEARCH_CATEGORY_DISABLED",
            registration.category,
            `Search category disabled: ${registration.category}`,
          );
        }
        return cloneCategory(registration);
      },
    ),
    useModel: vi.fn(),
    searchMemories: vi.fn(),
    getRoom: vi.fn(),
  } as unknown as TestRuntime;

  return runtime;
}

function createMessage(text = "search"): Memory {
  return {
    id: "message-id",
    entityId: "agent-id",
    roomId: "room-id",
    worldId: "world-id",
    agentId: "agent-id",
    content: { text },
  } as unknown as Memory;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SEARCH action", () => {
  it("registers the web category through plugin-web-search and dispatches to the web service", async () => {
    const runtime = createRuntime();
    const search = vi.fn(async () => ({
      answer: "A concise answer.",
      query: "runtime news",
      results: [
        {
          title: "Runtime News",
          url: "https://example.com/runtime",
          description: "Runtime release notes.",
        },
      ],
    }));
    runtime.__services.set(ServiceType.WEB_SEARCH, { search });

    await webSearchPlugin.init?.({}, runtime);

    expect(webSearchPlugin.actions).toEqual([]);
    expect(runtime.getSearchCategory("web").serviceType).toBe(
      ServiceType.WEB_SEARCH,
    );

    const result = await searchAction.handler(
      runtime,
      createMessage(),
      undefined,
      {
        parameters: {
          category: "web",
          query: "runtime news",
          filters: { topic: "news", includeImages: true },
          limit: 2,
          freshness: "day",
        },
      },
    );

    expect(result?.success).toBe(true);
    expect(search).toHaveBeenCalledWith(
      "runtime news",
      expect.objectContaining({
        days: 1,
        includeImages: true,
        limit: 2,
        topic: "news",
      }),
    );
    expect(result?.data).toMatchObject({
      actionName: "SEARCH",
      category: "web",
    });
  });

  it("returns a registry error for a missing category", async () => {
    const runtime = createRuntime();

    const result = await searchAction.handler(
      runtime,
      createMessage(),
      undefined,
      {
        parameters: {
          category: "missing",
          query: "anything",
        },
      },
    );

    expect(result?.success).toBe(false);
    expect(result?.values?.error).toBe("SEARCH_CATEGORY_NOT_FOUND");
  });

  it("stops post-action continuation when web search service is unavailable", async () => {
    const runtime = createRuntime();
    await webSearchPlugin.init?.({}, runtime);

    const result = await searchAction.handler(
      runtime,
      createMessage("what is the current BTC price?"),
      undefined,
      {
        parameters: {
          category: "web",
          query: "current BTC price",
        },
      },
    );

    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({
      actionName: "SEARCH",
      category: "web",
      suppressPostActionContinuation: true,
    });
  });

  it("validates category filters before dispatch", async () => {
    const runtime = createRuntime();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchAction.handler(
      runtime,
      createMessage(),
      undefined,
      {
        parameters: {
          category: "vectors",
          query: "budget",
          filters: { threshold: "high" },
        },
      },
    );

    expect(result?.success).toBe(false);
    expect(result?.values?.error).toBe("INVALID_FILTER");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("searches knowledge through the knowledge category", async () => {
    const runtime = createRuntime();
    const getKnowledge = vi.fn(async () => [
      {
        id: "knowledge-1",
        content: { text: "Stored knowledge result" },
        similarity: 0.82,
      },
    ]);
    runtime.__services.set("knowledge", { getKnowledge });

    const result = await searchAction.handler(
      runtime,
      createMessage(),
      undefined,
      {
        parameters: {
          category: "knowledge",
          query: "stored result",
          limit: 1,
        },
      },
    );

    expect(result?.success).toBe(true);
    expect(getKnowledge).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ text: "stored result" }),
      }),
      undefined,
    );
    expect(result?.data).toMatchObject({
      actionName: "SEARCH",
      category: "knowledge",
    });
  });

  it("searches plugins through the plugin manager category and applies filters", async () => {
    const runtime = createRuntime();
    const searchRegistry = vi.fn(async () => [
      {
        name: "@elizaos/plugin-wallet",
        description: "Wallet tools",
        score: 1,
        tags: ["wallet", "defi"],
        supports: { v2: true },
      },
      {
        name: "@elizaos/plugin-legacy-wallet",
        description: "Legacy wallet tools",
        score: 0.5,
        tags: ["wallet"],
        supports: { v1: true },
      },
    ]);
    runtime.__services.set("plugin_manager", { searchRegistry });

    const result = await searchAction.handler(
      runtime,
      createMessage(),
      undefined,
      {
        parameters: {
          category: "plugin",
          query: "wallet",
          filters: { tags: ["wallet"], runtimeVersion: "v2" },
          limit: 5,
        },
      },
    );

    expect(result?.success).toBe(true);
    expect(searchRegistry).toHaveBeenCalledWith("wallet", 5);
    expect(result?.data).toMatchObject({
      actionName: "SEARCH",
      category: "plugins",
      results: [expect.objectContaining({ name: "@elizaos/plugin-wallet" })],
    });
  });

  it("dispatches vector search with filters and wraps the backend action result", async () => {
    const runtime = createRuntime();
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          query: "budget",
          table: "knowledge",
          limit: 3,
          count: 1,
          results: [
            {
              id: "hit-1",
              text: "Budget planning notes",
              similarity: 0.91,
              roomId: null,
              entityId: null,
              createdAt: null,
              tableName: "knowledge",
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchAction.handler(
      runtime,
      createMessage(),
      undefined,
      {
        parameters: {
          category: "vector",
          query: "budget",
          filters: { table: "knowledge", threshold: 0.2 },
          limit: 3,
        },
      },
    );

    expect(result?.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(requestInit?.body));
    expect(body).toMatchObject({
      query: "budget",
      table: "knowledge",
      threshold: 0.2,
      limit: 3,
    });
    expect(result?.data).toMatchObject({
      actionName: "SEARCH",
      backendActionName: "SEARCH_VECTORS",
      category: "vectors",
    });
  });
});
