/**
 * Verifies runParentAgentBroker.
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { getProjectById, upsertProject } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runParentAgentBroker } from "../services/parent-agent-broker.js";
import {
  configureSpendLedger,
  resetSessionSpendUsd,
} from "../services/spend-allowance.js";

function createRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
    },
    deleteCache: async (key: string) => {
      cache.delete(key);
    },
    ...overrides,
  } as IAgentRuntime;
}

function brokerMessage(text = ""): Memory {
  return {
    entityId: "user-1",
    roomId: "room-1",
    content: { text, source: "test" },
    createdAt: Date.now(),
  } as Memory;
}

describe("runParentAgentBroker", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetSessionSpendUsd();
    configureSpendLedger(null);
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
    expect(result.text).toContain("advertising.accounts.media.status");
    expect(result.text).toContain("advertising.accounts.media.upload");
    expect(result.text).toContain("/api/v1/advertising/accounts/{id}/media");

    const creativeResult = await runParentAgentBroker({
      runtime: createRuntime(),
      sessionId: "session-1",
      args: { mode: "list-cloud-commands", query: "creative" },
    });
    expect(creativeResult.success).toBe(true);
    expect(creativeResult.text).toContain("advertising.creatives.list");
    expect(creativeResult.text).toContain("advertising.creatives.get");
    expect(creativeResult.text).toContain("advertising.creatives.update");
    expect(creativeResult.text).toContain("advertising.creatives.delete");
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

  it("forwards Cloud command query parameters", async () => {
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "test-key");
    vi.stubEnv("ELIZA_CLOUD_BASE_URL", "https://cloud.test");
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ ready: true, status: "AVAILABLE" }),
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
      args: {
        mode: "cloud-command",
        command: "advertising.accounts.media.status",
        params: {
          id: "account-1",
          query: {
            providerAssetResourceName: "customers/123/youTubeVideoUploads/abc",
          },
        },
      },
    });

    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/api/v1/advertising/accounts/account-1/media");
    expect(url.searchParams.get("providerAssetResourceName")).toBe(
      "customers/123/youTubeVideoUploads/abc",
    );
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("requires explicit confirmation before paid Cloud commands", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await runParentAgentBroker({
      runtime: createRuntime(),
      sessionId: "session-1",
      message: brokerMessage(),
      args: {
        mode: "cloud-command",
        command: "apps.charges.create",
        params: { id: "app-1", body: { amount: 10 } },
      },
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain("Reply yes");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs mutating Cloud commands after user yes", async () => {
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "test-key");
    vi.stubEnv("ELIZA_CLOUD_BASE_URL", "https://cloud.test");
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ success: true, apiKey: "secret" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = createRuntime();
    const cloudArgs = {
      mode: "cloud-command" as const,
      command: "apps.create",
      params: { body: { name: "Test App", description: "integration test" } },
    };

    const pending = await runParentAgentBroker({
      runtime,
      sessionId: "session-1",
      message: brokerMessage(),
      args: cloudArgs,
    });
    expect(pending.text).toContain("Reply yes");
    expect(fetchMock).not.toHaveBeenCalled();

    const result = await runParentAgentBroker({
      runtime,
      sessionId: "session-1",
      message: brokerMessage("yes"),
      args: cloudArgs,
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

  describe("apps.create project write-back (#14119)", () => {
    let stateDir: string;
    let priorStateDir: string | undefined;

    afterEach(() => {
      if (priorStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
      else process.env.ELIZA_STATE_DIR = priorStateDir;
      if (stateDir) rmSync(stateDir, { recursive: true, force: true });
    });

    function withProjectState(cloudAppId?: string): {
      projectId: string;
    } {
      stateDir = mkdtempSync(join(os.tmpdir(), "broker-project-"));
      priorStateDir = process.env.ELIZA_STATE_DIR;
      process.env.ELIZA_STATE_DIR = stateDir;
      const project = upsertProject({
        name: "shop",
        localPath: "/tmp/broker-shop",
        ...(cloudAppId ? { cloudAppId } : {}),
      });
      return { projectId: project.id };
    }

    /** Runtime whose task service maps the session's task to `projectId`,
     * matching the real ORCHESTRATOR_TASK_SERVICE.getTask contract the broker
     * resolves. */
    function taskBoundRuntime(projectId: string): IAgentRuntime {
      return createRuntime({
        getService: ((name: string) =>
          name === "ORCHESTRATOR_TASK_SERVICE"
            ? { getTask: async (_id: string) => ({ projectId }) }
            : null) as IAgentRuntime["getService"],
      });
    }

    function appsCreateArgs() {
      return {
        mode: "cloud-command" as const,
        command: "apps.create",
        params: { body: { name: "Test App" } },
      };
    }

    it("writes the created app id back to the task's bound project", async () => {
      const { projectId } = withProjectState();
      vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "test-key");
      vi.stubEnv("ELIZA_CLOUD_BASE_URL", "https://cloud.test");
      const fetchMock = vi.fn(async () => {
        // Cloud returns the created app nested under `app` (service shape).
        return new Response(
          JSON.stringify({ app: { id: "app_created_99" }, apiKey: "secret" }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const runtime = taskBoundRuntime(projectId);
      const session = {
        id: "session-9",
        status: "running",
        metadata: { taskId: "task-9" },
      } as unknown as Parameters<typeof runParentAgentBroker>[0]["session"];

      // Two-phase: pending confirmation, then the confirmed run.
      await runParentAgentBroker({
        runtime,
        sessionId: "session-9",
        session,
        message: brokerMessage(),
        args: appsCreateArgs(),
      });
      const result = await runParentAgentBroker({
        runtime,
        sessionId: "session-9",
        session,
        message: brokerMessage("yes"),
        args: appsCreateArgs(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.boundCloudAppId).toBe("app_created_99");
      // Persisted to the real registry, atomically.
      expect(getProjectById(projectId)?.cloudAppId).toBe("app_created_99");
    });

    it("does not write back when the session has no bound project", async () => {
      const { projectId } = withProjectState();
      vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "test-key");
      vi.stubEnv("ELIZA_CLOUD_BASE_URL", "https://cloud.test");
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ app: { id: "app_x" } }), {
              status: 201,
              headers: { "content-type": "application/json" },
            }),
        ),
      );
      // Runtime with a task service that returns an UNBOUND task (no projectId).
      const runtime = createRuntime({
        getService: ((name: string) =>
          name === "ORCHESTRATOR_TASK_SERVICE"
            ? { getTask: async () => ({ projectId: null }) }
            : null) as IAgentRuntime["getService"],
      });
      const session = {
        id: "s",
        status: "running",
        metadata: { taskId: "task-unbound" },
      } as unknown as Parameters<typeof runParentAgentBroker>[0]["session"];

      await runParentAgentBroker({
        runtime,
        sessionId: "s",
        session,
        message: brokerMessage(),
        args: appsCreateArgs(),
      });
      const result = await runParentAgentBroker({
        runtime,
        sessionId: "s",
        session,
        message: brokerMessage("yes"),
        args: appsCreateArgs(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.boundCloudAppId).toBeUndefined();
      // The project keeps no cloudAppId — nothing was written.
      expect(getProjectById(projectId)?.cloudAppId).toBeUndefined();
    });

    it("does not write back when apps.create fails (non-ok response)", async () => {
      const { projectId } = withProjectState();
      vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "test-key");
      vi.stubEnv("ELIZA_CLOUD_BASE_URL", "https://cloud.test");
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ error: "quota" }), {
              status: 402,
              headers: { "content-type": "application/json" },
            }),
        ),
      );
      const runtime = taskBoundRuntime(projectId);
      const session = {
        id: "sf",
        status: "running",
        metadata: { taskId: "task-fail" },
      } as unknown as Parameters<typeof runParentAgentBroker>[0]["session"];

      await runParentAgentBroker({
        runtime,
        sessionId: "sf",
        session,
        message: brokerMessage(),
        args: appsCreateArgs(),
      });
      const result = await runParentAgentBroker({
        runtime,
        sessionId: "sf",
        session,
        message: brokerMessage("yes"),
        args: appsCreateArgs(),
      });

      expect(result.success).toBe(false);
      expect(result.data?.boundCloudAppId).toBeUndefined();
      expect(getProjectById(projectId)?.cloudAppId).toBeUndefined();
    });
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

  describe("capped self-spend allowance", () => {
    function stubAllowance(capUsd: string) {
      // Point config resolution at a missing file so the cap is read from env.
      vi.stubEnv("ELIZA_CONFIG_PATH", "/nonexistent/eliza-config.json");
      vi.stubEnv("ELIZA_AGENT_SPEND_CAP_USD", capUsd);
      vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "test-key");
      vi.stubEnv("ELIZA_CLOUD_BASE_URL", "https://cloud.test");
    }

    it("self-authorizes a fixed-cost self-spend command within the cap and strips the spend hint", async () => {
      stubAllowance("50");
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, id: "container-1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const result = await runParentAgentBroker({
        runtime: createRuntime(),
        sessionId: "spend-within",
        message: brokerMessage(),
        args: {
          mode: "cloud-command",
          command: "containers.create",
          params: { image: "ghcr.io/acme/app:latest", spendEstimateUsd: 14.95 },
        },
      });

      expect(result.success).toBe(true);
      expect(result.text).not.toContain("Reply yes");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(url.pathname).toBe("/api/v1/containers");
      // The reserved spend hint must NOT leak into the Cloud request body.
      expect(init.body).toBe(
        JSON.stringify({ image: "ghcr.io/acme/app:latest" }),
      );
    });

    it("requires confirmation when a fixed-cost self-spend command exceeds the allowance", async () => {
      stubAllowance("10");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await runParentAgentBroker({
        runtime: createRuntime(),
        sessionId: "spend-over",
        message: brokerMessage(),
        args: {
          mode: "cloud-command",
          command: "containers.create",
          params: { image: "ghcr.io/acme/app:latest", spendEstimateUsd: 14.95 },
        },
      });

      expect(result.text).toContain("Reply yes");
      expect(result.text).toContain("allowance");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("requires confirmation for variable-cost self-spend even with a positive hint", async () => {
      stubAllowance("50");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await runParentAgentBroker({
        runtime: createRuntime(),
        sessionId: "variable-spend",
        message: brokerMessage(),
        args: {
          mode: "cloud-command",
          command: "domains.buy",
          params: { id: "app-1", domain: "myapp.com", spendEstimateUsd: 0.01 },
        },
      });

      expect(result.text).toContain("Reply yes");
      expect(result.text).toContain("child-declared spend estimates");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("enforces the cap from the DURABLE total after a restart (#8924)", async () => {
      stubAllowance("10");
      // A durable ledger holding $9 already spent by a PRIOR process for this
      // session (persisted on the session record's metadata.spendUsd).
      const persisted = new Map<string, number>([["spend-restart", 9]]);
      configureSpendLedger({
        load: async (sid) => persisted.get(sid) ?? 0,
        save: async (sid, total) => {
          persisted.set(sid, total);
        },
      });
      // Simulate a restart: the in-memory ledger is empty, only the durable
      // record survives. Without rehydration the cap check would see $0.
      resetSessionSpendUsd();

      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await runParentAgentBroker({
        runtime: createRuntime(),
        sessionId: "spend-restart",
        message: brokerMessage(),
        args: {
          mode: "cloud-command",
          command: "containers.create",
          params: { image: "ghcr.io/acme/app:latest", spendEstimateUsd: 2 },
        },
      });

      // $9 persisted + $2 now = $11 > $10 cap → must fall back to a human
      // confirmation, proving the broker rehydrated the persisted total before
      // enforcing the cap (the durable record survived the "restart").
      expect(result.text).toContain("Reply yes");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("still requires confirmation for destructive commands even under an allowance", async () => {
      stubAllowance("1000");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await runParentAgentBroker({
        runtime: createRuntime(),
        sessionId: "spend-destructive",
        message: brokerMessage(),
        args: {
          mode: "cloud-command",
          command: "apps.delete",
          params: { id: "app-1" },
        },
      });

      expect(result.text).toContain("Reply yes");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("auto-authorizes non-self-spend mutating commands under an allowance", async () => {
      stubAllowance("50");
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true }), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const result = await runParentAgentBroker({
        runtime: createRuntime(),
        sessionId: "spend-mutating",
        message: brokerMessage(),
        args: {
          mode: "cloud-command",
          command: "apps.create",
          params: { body: { name: "Auto App" } },
        },
      });

      expect(result.text).not.toContain("Reply yes");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(url.pathname).toBe("/api/v1/apps");
      expect(init.method).toBe("POST");
    });
  });
});
