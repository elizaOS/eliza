/**
 * Exercises the RUNTIME action's public metadata and each operation through
 * its real handler. The deterministic harness uses in-memory runtime services,
 * a loopback HTTP server for config reloads, and the shared restart registry;
 * the module under test is never mocked.
 */
import { createServer } from "node:http";
import type {
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { setRestartHandler } from "@elizaos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeAction } from "./runtime.ts";

const agentId = "00000000-0000-0000-0000-0000000000aa";

interface RuntimeFixtureOptions {
  actions?: Action[];
  providerCount?: number;
  services?: Map<string, unknown[]>;
  character?: { name?: string; settings?: Record<string, unknown> };
  awarenessService?: unknown;
  createdMemories?: Memory[];
}

function namedAction(
  name: string,
  description: string,
  similes?: string[],
): Action {
  return { name, description, similes } as Action;
}

function makeRuntime(options: RuntimeFixtureOptions = {}): IAgentRuntime {
  return {
    agentId,
    actions: options.actions ?? [],
    providers: Array.from({ length: options.providerCount ?? 0 }, () => ({})),
    services: options.services,
    character: options.character ?? { name: "test-agent", settings: {} },
    getService: (serviceType: string) =>
      serviceType === "AWARENESS_REGISTRY"
        ? (options.awarenessService ?? null)
        : null,
    createMemory: async (memory: Memory) => {
      options.createdMemories?.push(memory);
    },
  } as unknown as IAgentRuntime;
}

async function invoke(
  parameters: Record<string, unknown>,
  runtime: IAgentRuntime = makeRuntime(),
  message?: Memory,
): Promise<ActionResult> {
  const result = await runtimeAction.handler(
    runtime,
    message as Memory,
    undefined,
    { parameters } as HandlerOptions,
    undefined,
  );
  if (!result) throw new Error("RUNTIME handler returned no result");
  return result;
}

function setEnv(name: string, value: string | undefined): () => void {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  return () => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  };
}

interface ReloadResponse {
  status: number;
  body: string;
  contentType?: string;
}

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  body: string;
  authorization: string | undefined;
  contentType: string | undefined;
}

async function withReloadServer(
  response: ReloadResponse,
  run: () => Promise<ActionResult>,
): Promise<{ result: ActionResult; request: CapturedRequest }> {
  let resolveRequest: (request: CapturedRequest) => void = () => {};
  const requestReceived = new Promise<CapturedRequest>((resolve) => {
    resolveRequest = resolve;
  });
  const server = createServer((request, reply) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      resolveRequest({
        method: request.method,
        url: request.url,
        body: Buffer.concat(chunks).toString("utf8"),
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
      });
      reply.writeHead(response.status, {
        "Content-Type": response.contentType ?? "application/json",
      });
      reply.end(response.body);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Loopback reload server did not bind a TCP port");
  }
  const restorePort = setEnv("ELIZA_PORT", String(address.port));
  try {
    const result = await run();
    return { result, request: await requestReceived };
  } finally {
    restorePort();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function reserveClosedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Port reservation did not bind a TCP port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

afterEach(() => {
  vi.useRealTimers();
  setRestartHandler(() => {});
});

describe("runtimeAction contract", () => {
  it("publishes owner-gated runtime operations and accepts validation", async () => {
    expect(runtimeAction).toMatchObject({
      name: "RUNTIME",
      roleGate: { minRole: "OWNER" },
      contexts: [
        "admin",
        "agent_internal",
        "settings",
        "general",
        "connectors",
        "wallet",
      ],
    });
    await expect(
      runtimeAction.validate?.(makeRuntime(), {} as Memory),
    ).resolves.toBe(true);

    const actionParameter = runtimeAction.parameters?.find(
      (parameter) => parameter.name === "action",
    );
    expect(actionParameter?.schema).toMatchObject({
      enum: [
        "status",
        "self_status",
        "describe_actions",
        "reload_config",
        "restart",
        "list_actions",
        "restart_agent",
      ],
    });
  });

  it.each([
    [{}, ""],
    [{ action: "not-real" }, "not-real"],
  ])(
    "rejects an invalid operation without dispatching: %j",
    async (params, op) => {
      const result = await invoke(params);

      expect(result).toMatchObject({
        success: false,
        values: { error: "RUNTIME_INVALID", op },
        data: { actionName: "RUNTIME", action: op, error: "RUNTIME_INVALID" },
      });
      expect(result.text).toContain(
        "Valid: status, self_status, describe_actions, reload_config, restart",
      );
    },
  );

  it("prefers action over subaction and op, then falls back through both", async () => {
    const runtime = makeRuntime();

    const actionResult = await invoke(
      { action: "status", subaction: "unknown", op: "unknown" },
      runtime,
    );
    const subactionResult = await invoke(
      { subaction: "status", op: "unknown" },
      runtime,
    );
    const opResult = await invoke({ op: "status" }, runtime);

    expect(actionResult.data).toMatchObject({ op: "status" });
    expect(subactionResult.data).toMatchObject({ op: "status" });
    expect(opResult.data).toMatchObject({ op: "status" });
  });
});

describe("RUNTIME status", () => {
  it("returns only aggregate counts for the counts view", async () => {
    const services = new Map<string, unknown[]>([
      ["alpha", [{}, {}]],
      ["beta", [{}]],
    ]);
    const runtime = makeRuntime({
      actions: [namedAction("ONE", "first"), namedAction("TWO", "second")],
      providerCount: 1,
      services,
      character: {
        name: "count-agent",
        settings: { MODEL_PROVIDER: "provider-model", model: "fallback-model" },
      },
    });

    const result = await invoke({ action: "status", view: "counts" }, runtime);

    expect(result.text).toBe("Actions: 2, Providers: 1, Services: 3");
    expect(result.values).toEqual({
      actionCount: 2,
      providerCount: 1,
      serviceCount: 3,
    });
    expect(result.data).toMatchObject({
      op: "status",
      view: "counts",
      snapshot: {
        agentName: "count-agent",
        agentId,
        model: "provider-model",
        serviceCount: 3,
      },
    });
  });

  it("defaults to a summary and exposes missing runtime metadata explicitly", async () => {
    const runtime = makeRuntime({
      character: { settings: {} },
    });

    const result = await invoke({ action: "status", view: "invalid" }, runtime);

    expect(result.text).toMatch(
      /^Agent: unknown\nModel: n\/a\nActions: 0, Providers: 0, Services: 0\nGenerated: \d{4}-\d{2}-\d{2}T/,
    );
    expect(result.data).toMatchObject({
      view: "summary",
      snapshot: { agentName: "unknown", model: null },
    });
  });

  it("uses the legacy model setting when MODEL_PROVIDER is absent", async () => {
    const runtime = makeRuntime({
      character: { name: "legacy-agent", settings: { model: "legacy-model" } },
    });

    const result = await invoke({ action: "status" }, runtime);

    expect(result.text).toContain("Model: legacy-model");
    expect(result.data).toMatchObject({
      snapshot: { model: "legacy-model" },
    });
  });
});

describe("RUNTIME describe_actions", () => {
  it("sorts a copied roster, preserves ties, and formats descriptions", async () => {
    const actions = [
      namedAction("Zulu", ""),
      namedAction("Alpha", "  first description  ", ["FIRST_ALIAS"]),
      namedAction("Alpha", "second description"),
    ];
    const runtime = makeRuntime({ actions });

    const result = await invoke({ action: "list_actions" }, runtime);

    expect(result.text).toBe(
      "Registered 3 action(s).\n\nAlpha — first description\nAlpha — second description\nZulu",
    );
    expect(result.values).toEqual({ count: 3, totalRegistered: 3 });
    expect(result.data).toMatchObject({
      op: "describe_actions",
      filter: "",
      actions: [
        {
          name: "Alpha",
          description: "  first description  ",
          similes: ["FIRST_ALIAS"],
        },
        { name: "Alpha", description: "second description", similes: [] },
        { name: "Zulu", description: "", similes: [] },
      ],
    });
    expect(actions.map((action) => action.name)).toEqual([
      "Zulu",
      "Alpha",
      "Alpha",
    ]);
  });

  it("trims and applies a case-insensitive filter to a single match", async () => {
    const runtime = makeRuntime({
      actions: [
        namedAction("SEND_EMAIL", "send mail"),
        namedAction("CALENDAR", "list events"),
      ],
    });

    const result = await invoke(
      { action: "describe_actions", filter: "  email  " },
      runtime,
    );

    expect(result.text).toBe(
      'Found 1 action(s) matching "email".\n\nSEND_EMAIL — send mail',
    );
    expect(result.values).toEqual({ count: 1, totalRegistered: 2 });
  });

  it("returns a scoped empty result without losing the registered total", async () => {
    const runtime = makeRuntime({
      actions: [namedAction("STATUS", "read status")],
    });

    const result = await invoke(
      { action: "describe_actions", filter: "missing" },
      runtime,
    );

    expect(result.text).toBe('Found 0 action(s) matching "missing".\n');
    expect(result.values).toEqual({ count: 0, totalRegistered: 1 });
    expect(result.data).toMatchObject({ filter: "missing", actions: [] });
  });
});

describe("RUNTIME self_status defaults", () => {
  it("normalizes unsupported module and detail values before querying", async () => {
    const calls: Array<{ module: string; detailLevel: string }> = [];
    const awarenessService = {
      getDetail: async (
        _runtime: IAgentRuntime,
        module: string,
        detailLevel: string,
      ) => {
        calls.push({ module, detailLevel });
        return "broken surrogate: \ud800";
      },
    };

    const result = await invoke(
      { action: "self_status", module: "unsupported", detailLevel: "verbose" },
      makeRuntime({ awarenessService }),
    );

    expect(calls).toEqual([{ module: "all", detailLevel: "brief" }]);
    expect(result.text).toBe("broken surrogate: �");
    expect(result.values).toEqual({ module: "all", detailLevel: "brief" });
    expect(result.data).toMatchObject({ truncated: false });
  });
});

describe("RUNTIME reload_config", () => {
  it("posts to the loopback API and reports applied and restart-only fields", async () => {
    const restoreToken = setEnv("ELIZA_API_TOKEN", "runtime-test-token");
    try {
      const { result, request } = await withReloadServer(
        {
          status: 200,
          body: JSON.stringify({
            reloaded: true,
            applied: ["logging.level"],
            requiresRestart: ["database.url"],
          }),
        },
        () => invoke({ action: "reload_config" }),
      );

      expect(request).toEqual({
        method: "POST",
        url: "/api/config/reload",
        body: "{}",
        authorization: "Bearer runtime-test-token",
        contentType: "application/json",
      });
      expect(result.text).toBe(
        "Applied: logging.level\nRestart required for: database.url (run RUNTIME op=restart).",
      );
      expect(result.values).toEqual({
        applied: ["logging.level"],
        requiresRestart: ["database.url"],
        restartNeeded: true,
      });
    } finally {
      restoreToken();
    }
  });

  it("treats omitted response arrays as no changes", async () => {
    const { result } = await withReloadServer(
      { status: 200, body: JSON.stringify({ reloaded: true }) },
      () => invoke({ action: "reload_config" }),
    );

    expect(result.text).toBe("No hot-reloadable fields changed.");
    expect(result.values).toEqual({
      applied: [],
      requiresRestart: [],
      restartNeeded: false,
    });
  });

  it("surfaces a structured HTTP error body", async () => {
    const { result } = await withReloadServer(
      { status: 503, body: JSON.stringify({ error: "reload is locked" }) },
      () => invoke({ action: "reload_config" }),
    );

    expect(result).toMatchObject({
      success: false,
      text: "Config reload failed: reload is locked",
      values: {
        error: "RUNTIME_RELOAD_CONFIG_FAILED",
        op: "reload_config",
      },
    });
  });

  it("falls back to the HTTP status for a non-JSON error body", async () => {
    const { result } = await withReloadServer(
      { status: 502, body: "bad gateway", contentType: "text/plain" },
      () => invoke({ action: "reload_config" }),
    );

    expect(result.text).toBe("Config reload failed: HTTP 502");
    expect(result.success).toBe(false);
  });

  it("returns a failure when the loopback transport is unavailable", async () => {
    const port = await reserveClosedPort();
    const restorePort = setEnv("ELIZA_PORT", String(port));
    try {
      const result = await invoke({ action: "reload_config" });

      expect(result.success).toBe(false);
      expect(result.text).toMatch(/^Config reload failed: /);
      expect(result.values).toMatchObject({
        error: "RUNTIME_RELOAD_CONFIG_FAILED",
      });
    } finally {
      restorePort();
    }
  });
});

describe("RUNTIME restart", () => {
  it("refuses a self-edit restart when the development gate is closed", async () => {
    vi.useFakeTimers();
    const restoreSelfEdit = setEnv("ELIZA_ENABLE_SELF_EDIT", "0");
    const createdMemories: Memory[] = [];
    try {
      const result = await invoke(
        { action: "restart", source: "self-edit", reason: "apply edit" },
        makeRuntime({ createdMemories }),
        { roomId: "room-1", content: { text: "/restart" } } as Memory,
      );

      expect(result).toMatchObject({
        success: false,
        values: { error: "RESTART_GATE_CLOSED" },
        data: {
          op: "restart",
          source: "self-edit",
          refused: "self-edit-not-enabled",
        },
      });
      expect(createdMemories).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      restoreSelfEdit();
    }
  });

  it("persists an explicit chat restart before delayed dispatch", async () => {
    vi.useFakeTimers();
    const restartReasons: Array<string | undefined> = [];
    setRestartHandler((reason) => {
      restartReasons.push(reason);
    });
    const createdMemories: Memory[] = [];
    const message = {
      roomId: "00000000-0000-0000-0000-0000000000bb",
      worldId: "00000000-0000-0000-0000-0000000000cc",
      content: { text: "  /ReStArT now  " },
    } as Memory;

    const result = await invoke(
      { action: "restart", source: "user", reason: "upgrade" },
      makeRuntime({ createdMemories }),
      message,
    );

    expect(result).toMatchObject({
      success: true,
      text: "Restarting… (upgrade)",
      values: { restarting: true },
      data: { source: "user", reason: "upgrade", fromChat: true },
    });
    expect(createdMemories).toHaveLength(1);
    expect(createdMemories[0]).toMatchObject({
      entityId: agentId,
      roomId: message.roomId,
      worldId: message.worldId,
      content: {
        text: "Restarting… (upgrade)",
        source: "eliza",
        type: "system",
      },
    });
    expect(createdMemories[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    await vi.advanceTimersByTimeAsync(1_499);
    expect(restartReasons).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(restartReasons).toEqual(["upgrade"]);
  });

  it("supports the legacy alias without treating ordinary chat as explicit", async () => {
    vi.useFakeTimers();
    const restartReasons: Array<string | undefined> = [];
    setRestartHandler((reason) => {
      restartReasons.push(reason);
    });
    const createdMemories: Memory[] = [];

    const result = await invoke(
      {
        action: "restart_agent",
        source: "not-a-source",
        reason: "invalid surrogate \ud800",
      },
      makeRuntime({ createdMemories }),
      { content: { text: "tell me the weather" } } as Memory,
    );

    expect(result).toMatchObject({
      success: true,
      text: "Runtime restart scheduled (invalid surrogate �).",
      data: {
        op: "restart",
        reason: "invalid surrogate �",
        source: undefined,
        fromChat: false,
      },
    });
    expect(createdMemories).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(restartReasons).toEqual(["invalid surrogate �"]);
  });

  it("schedules a reasonless programmatic restart", async () => {
    vi.useFakeTimers();
    const restartReasons: Array<string | undefined> = [];
    setRestartHandler((reason) => {
      restartReasons.push(reason);
    });

    const result = await invoke({
      action: "restart",
      source: "plugin-install",
    });

    expect(result).toMatchObject({
      success: true,
      text: "Runtime restart scheduled.",
      data: {
        reason: undefined,
        source: "plugin-install",
        fromChat: false,
      },
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(restartReasons).toEqual([undefined]);
  });
});
