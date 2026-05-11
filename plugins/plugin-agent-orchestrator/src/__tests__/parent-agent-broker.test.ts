import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runParentAgentBroker } from "../services/parent-agent-broker.js";

function createRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
  return {
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    ...overrides,
  } as IAgentRuntime;
}

describe("runParentAgentBroker", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("lists matching parent actions", async () => {
    const runtime = createRuntime({
      actions: [
        {
          name: "GET_CALENDAR_AVAILABILITY",
          description: "Find open time on the user's calendar.",
          similes: ["calendar"],
        },
        {
          name: "SEARCH_GITHUB",
          description: "Search GitHub repositories.",
          similes: ["github"],
        },
      ],
    } as Partial<IAgentRuntime>);

    const result = await runParentAgentBroker({
      runtime,
      sessionId: "session-1",
      args: { mode: "list-actions", query: "calendar" },
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain("GET_CALENDAR_AVAILABILITY");
    expect(result.text).not.toContain("SEARCH_GITHUB");
  });

  it("requires a request in ask mode", async () => {
    const result = await runParentAgentBroker({
      runtime: createRuntime(),
      sessionId: "session-1",
      args: {},
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("requires a `request` string");
  });

  it("routes ask mode through the parent message service", async () => {
    const createMemory = vi.fn().mockResolvedValue(undefined);
    const handleMessage = vi.fn(async (_runtime, memory, callback) => {
      expect(memory.content.text).toContain("Use my calendar");
      await callback({ text: "Calendar says tomorrow at 2pm works." });
      return { responseContent: { text: "" } };
    });
    const runtime = createRuntime({
      createMemory,
      messageService: { handleMessage },
    } as Partial<IAgentRuntime>);

    const result = await runParentAgentBroker({
      runtime,
      sessionId: "session-1",
      session: {
        id: "session-1",
        status: "running",
        workdir: "/repo",
        metadata: {
          userId: "user-1",
          roomId: "room-1",
          source: "test",
        },
      } as never,
      args: { request: "Use my calendar to find time tomorrow." },
    });

    expect(createMemory).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.text).toContain("Calendar says tomorrow at 2pm works.");
  });

  it("lists deterministic Eliza Cloud commands", async () => {
    const result = await runParentAgentBroker({
      runtime: createRuntime(),
      sessionId: "session-1",
      args: { mode: "list-cloud-commands", query: "media" },
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain("media.music.generate");
    expect(result.text).toContain("/api/v1/generate-music");
    expect(result.text).toContain("advertising.accounts.media.upload");
    expect(result.text).toContain("/api/v1/advertising/accounts/{id}/media");
  });

  it("runs read-only Cloud commands through the configured Cloud API", async () => {
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "test-key");
    vi.stubEnv("ELIZA_CLOUD_BASE_URL", "https://cloud.test");
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ apps: [{ id: "app-1", apiKey: "secret" }] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runParentAgentBroker({
      runtime: createRuntime(),
      sessionId: "session-1",
      args: { mode: "cloud-command", command: "apps.list" },
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain("apps.list succeeded (200)");
    expect(result.text).toContain("[redacted]");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/api/v1/apps");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toMatch(
      /^Bearer /,
    );
  });

  it("requires explicit confirmation before paid Cloud commands", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await runParentAgentBroker({
      runtime: createRuntime(),
      sessionId: "session-1",
      args: {
        mode: "cloud-command",
        command: "apps.charges.create",
        params: { id: "app-1", body: { amount: 10 } },
      },
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("confirmation_required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs confirmed mutating Cloud commands", async () => {
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "test-key");
    vi.stubEnv("ELIZA_CLOUD_BASE_URL", "https://cloud.test");
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ success: true, apiKey: "secret" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runParentAgentBroker({
      runtime: createRuntime(),
      sessionId: "session-1",
      args: {
        mode: "cloud-command",
        command: "apps.create",
        confirmed: true,
        params: { body: { name: "Test App", description: "integration test" } },
      },
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain("apps.create succeeded (201)");
    expect(result.text).toContain("[redacted]");
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/api/v1/apps");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(
      JSON.stringify({ name: "Test App", description: "integration test" }),
    );
  });

  it("does not leak Cloud path params into inferred request bodies", async () => {
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "test-key");
    vi.stubEnv("ELIZA_CLOUD_BASE_URL", "https://cloud.test");
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ success: true, available: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runParentAgentBroker({
      runtime: createRuntime(),
      sessionId: "session-1",
      args: {
        mode: "cloud-command",
        command: "domains.check",
        params: { id: "app-1", domain: "example.com" },
      },
    });

    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/api/v1/apps/app-1/domains/check");
    expect(init.body).toBe(JSON.stringify({ domain: "example.com" }));
  });
});
