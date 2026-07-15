/**
 * Cross-seam integration of the `/model small|large|coding|show` slash
 * handler (@elizaos/plugin-commands) against the REAL model-config route: a
 * live node:http server dispatches to handleModelConfigRoutes with real
 * json/readJsonBody transport helpers, and the command handler reaches it via
 * its production loopback fetch (ELIZA_PORT). No stubbed fetch and no mocked
 * route — this pins that the slash grammar, the route's validation contract,
 * and the narrated replies cannot drift apart. Only the catalog, config
 * store, and operation manager are injected (the route's designed seams).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { initForRuntime, resolveCommand } from "@elizaos/plugin-commands";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/config";
import { buildModelCatalog } from "./model-catalog";
import { handleModelConfigRoutes } from "./model-config-routes";

const catalog = buildModelCatalog({
  readFile: () => {
    throw new Error("ENOENT");
  },
  env: {} as NodeJS.ProcessEnv,
});

function makeRuntime(): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: "agent-model-config-e2e",
    character: { name: "Eliza", settings: {} },
    actions: [],
    getSetting: () => null,
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
    deleteCache: async (key: string) => cache.delete(key),
  } as unknown as IAgentRuntime;
}

function msg(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000012",
    entityId: "00000000-0000-0000-0000-0000000000ad",
    roomId: "room-model-config-e2e",
    content: { text, source: "client_chat" },
  } as unknown as Memory;
}

const OWNER = { isAuthorized: true, isElevated: true };

interface Harness {
  config: ElizaConfig;
  processEnv: NodeJS.ProcessEnv;
  saveElizaConfig: ReturnType<typeof vi.fn>;
  managerStart: ReturnType<typeof vi.fn>;
  runtime: IAgentRuntime;
  close: () => Promise<void>;
}

const priorElizaPort = process.env.ELIZA_PORT;
let activeHarness: Harness | null = null;

async function startHarness(
  opts: { config?: ElizaConfig; managerStart?: ReturnType<typeof vi.fn> } = {},
): Promise<Harness> {
  const config: ElizaConfig = opts.config ?? {};
  const processEnv: NodeJS.ProcessEnv = {};
  const saveElizaConfig = vi.fn();
  const managerStart =
    opts.managerStart ??
    vi.fn(async (req: { prepare?: () => Promise<unknown> }) => {
      await req.prepare?.();
      return { kind: "accepted", operation: { id: "op-e2e" } };
    });

  const server = http.createServer((req, res) => {
    void (async () => {
      const handled = await handleModelConfigRoutes({
        req,
        res,
        method: req.method ?? "GET",
        pathname: new URL(req.url ?? "/", "http://127.0.0.1").pathname,
        json: (r: http.ServerResponse, body: unknown, status = 200) => {
          r.writeHead(status, { "Content-Type": "application/json" });
          r.end(JSON.stringify(body));
        },
        readJsonBody: async (rq: http.IncomingMessage) => {
          const chunks: Buffer[] = [];
          for await (const chunk of rq) chunks.push(chunk as Buffer);
          return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        },
        state: { config },
        saveElizaConfig,
        runtimeOperationManager: { start: managerStart },
        catalog,
        processEnv,
      } as never);
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    })();
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  // The slash handler resolves its loopback target from ELIZA_PORT — point it
  // at this live route server, exactly like production points it at app-core.
  process.env.ELIZA_PORT = String((server.address() as AddressInfo).port);

  initForRuntime("agent-model-config-e2e");
  const harness: Harness = {
    config,
    processEnv,
    saveElizaConfig,
    managerStart,
    runtime: makeRuntime(),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
  activeHarness = harness;
  return harness;
}

afterEach(async () => {
  await activeHarness?.close();
  activeHarness = null;
  if (priorElizaPort === undefined) delete process.env.ELIZA_PORT;
  else process.env.ELIZA_PORT = priorElizaPort;
});

describe("/model slash handler ↔ real /api/models/config route", () => {
  it("applies a coding write end-to-end: config seams written, restart-free reply", async () => {
    const h = await startHarness();

    const r = await resolveCommand(
      h.runtime,
      msg("/model coding codex gpt-5.6-terra xhigh"),
      OWNER,
    );

    expect(r.handled).toBe(true);
    expect(r.reply).toContain("gpt-5.6-terra");
    expect(r.reply).toContain("no restart needed");
    expect(h.saveElizaConfig).toHaveBeenCalledTimes(1);
    const env = (h.config as { env?: Record<string, unknown> }).env ?? {};
    expect(env.ELIZA_CODEX_MODEL_POWERFUL).toBe("gpt-5.6-terra");
    expect(env.ELIZA_CODEX_EFFORT).toBe("xhigh");
    expect(
      (env.vars as Record<string, string>).ELIZA_CODEX_MODEL_POWERFUL,
    ).toBe("gpt-5.6-terra");
    expect(h.processEnv.ELIZA_CODEX_MODEL_POWERFUL).toBe("gpt-5.6-terra");
    expect(h.managerStart).not.toHaveBeenCalled();
  });

  it("surfaces the managed codex-acp effort-contract 400 verbatim", async () => {
    const h = await startHarness();

    const r = await resolveCommand(
      h.runtime,
      msg("/model coding codex gpt-5.6-terra ultra"),
      OWNER,
    );

    expect(r.reply).toContain("managed codex-acp contract");
    expect(r.reply).toContain("low, medium, high, xhigh");
    expect(h.saveElizaConfig).not.toHaveBeenCalled();
  });

  it("surfaces the real ambiguous-provider 400, and the provider-qualified retry restarts", async () => {
    const h = await startHarness();

    const ambiguous = await resolveCommand(
      h.runtime,
      msg("/model large zai-glm-4.7"),
      OWNER,
    );
    expect(ambiguous.reply).toContain("multiple providers");
    expect(ambiguous.reply).toContain("cerebras");
    expect(ambiguous.reply).toContain("elizacloud");

    const qualified = await resolveCommand(
      h.runtime,
      msg("/model large cerebras/zai-glm-4.7 high"),
      OWNER,
    );
    expect(qualified.reply).toContain("restarting the agent to apply");
    expect(qualified.reply).toContain(
      "OPENAI_REASONING_EFFORT is shared by the small and large chat targets",
    );
    expect(h.managerStart).toHaveBeenCalledTimes(1);
    const env = (h.config as { env?: Record<string, unknown> }).env ?? {};
    expect(env.OPENAI_LARGE_MODEL).toBe("zai-glm-4.7");
    expect(env.OPENAI_REASONING_EFFORT).toBe("high");
  });

  it("surfaces the real 409 when the operation manager is busy", async () => {
    const h = await startHarness({
      managerStart: vi.fn(async () => ({
        kind: "rejected-busy",
        activeOperationId: "op-live",
      })),
    });

    const r = await resolveCommand(
      h.runtime,
      msg("/model small cerebras/gemma-4-31b"),
      OWNER,
    );
    expect(r.reply).toContain("already in progress");
    expect(r.reply).toContain("op-live");
    expect(h.saveElizaConfig).not.toHaveBeenCalled();
  });

  it("/model show renders the route's real effective config with sources", async () => {
    const h = await startHarness({
      config: {
        env: {
          OPENAI_LARGE_MODEL: "zai-glm-4.7",
          vars: { ANTHROPIC_SMALL_MODEL: "claude-haiku-4-5-20251001" },
        },
      } as ElizaConfig,
    });

    const r = await resolveCommand(h.runtime, msg("/model show"), OWNER);

    // Humanized slots (#16243): model + friendly source per slot — raw env
    // keys must never reach the operator.
    expect(r.reply).toContain("small: claude-haiku-4-5-20251001 (app config");
    expect(r.reply).toContain("large: zai-glm-4.7 (app config");
    // The route's designed coding defaults surface even with nothing written.
    expect(r.reply).toContain("codex: gpt-5.6-sol (default)");
    expect(r.reply).toContain("claude: claude-opus-4-8 (default)");
    expect(r.reply).not.toContain("MODEL_POWERFUL");
    expect(r.reply).not.toContain("unset");
  });
});
