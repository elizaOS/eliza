/** Exercises automations compat routes behavior with deterministic app-core test fixtures. */
import http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "../../src/api/compat-route-shared";

type AutomationsCompatRoutesModule =
  typeof import("../../src/api/automations-compat-routes");

const ensureRouteAuthorizedMock = vi.fn();

vi.doMock("@elizaos/agent", () => ({
  loadElizaConfig: () => ({
    ui: { assistant: { name: "Eliza" } },
    agents: { defaults: { adminEntityId: "admin-entity-id" } },
  }),
}));

vi.doMock("../../src/api/auth.ts", () => ({
  ensureRouteAuthorized: (...args: unknown[]) =>
    ensureRouteAuthorizedMock(...args),
}));

import {
  buildRuntimeCapabilityNodes,
  clearAutomationNodeContributorsForTests,
  type RuntimeCapabilityNodeSpec,
  registerAutomationNodeContributor,
} from "../../src/api/automation-node-contributors";

// Representative crypto specs mirroring what plugin-wallet / plugin-hyperliquid
// register through the contributor extension point. The plugins' own suites
// assert their exact specs; here we prove app-core's catalog drains such
// contributors and gates availability on runtime capabilities.
const CRYPTO_CONTRIBUTOR_SPECS: RuntimeCapabilityNodeSpec[] = [
  {
    id: "crypto:evm.swap",
    label: "EVM swap",
    description:
      "EVM token swap automation backed by a loaded EVM runtime action.",
    class: "action",
    backingCapability: "SWAP",
    actionNames: ["SWAP", "SWAP_TOKENS", "SWAP_TOKEN"],
    pluginNames: ["evm", "wallet"],
    ownerScoped: true,
    enabledWithoutRuntimeCapability: false,
    disabledReason: "Load the EVM plugin with swap support.",
  },
  {
    id: "crypto:evm.bridge",
    label: "EVM bridge",
    description:
      "EVM cross-chain bridge automation backed by a loaded EVM runtime action.",
    class: "action",
    backingCapability: "CROSS_CHAIN_TRANSFER",
    actionNames: ["CROSS_CHAIN_TRANSFER", "BRIDGE", "BRIDGE_TOKENS"],
    pluginNames: ["evm", "wallet"],
    ownerScoped: true,
    enabledWithoutRuntimeCapability: false,
    disabledReason: "Load the EVM plugin with bridge support.",
  },
  {
    id: "crypto:solana.swap",
    label: "Solana swap",
    description:
      "Solana token swap automation backed by a loaded Solana runtime action.",
    class: "action",
    backingCapability: "SWAP_SOLANA",
    actionNames: ["SWAP_SOLANA", "SWAP_SOL"],
    pluginNames: ["chain_solana", "solana", "wallet"],
    ownerScoped: true,
    enabledWithoutRuntimeCapability: false,
    disabledReason: "Load the Solana plugin with swap support.",
  },
  {
    id: "crypto:hyperliquid.action",
    label: "Hyperliquid action",
    description:
      "Hyperliquid automation entry point backed by a loaded Hyperliquid runtime plugin.",
    class: "action",
    backingCapability: "HYPERLIQUID_ACTION",
    actionNames: ["HYPERLIQUID_ACTION", "HYPERLIQUID_ORDER"],
    pluginNames: ["hyperliquid", "@elizaos/plugin-hyperliquid"],
    ownerScoped: true,
    enabledWithoutRuntimeCapability: false,
    disabledReason: "Load the Hyperliquid runtime plugin.",
  },
  {
    id: "trigger:order.event",
    label: "Order event",
    description:
      "React to order lifecycle events emitted by a loaded trading venue plugin.",
    class: "trigger",
    backingCapability: "ORDER_EVENT",
    actionNames: ["ORDER_EVENT", "ORDER_FILLED", "HYPERLIQUID_ACTION"],
    pluginNames: ["hyperliquid", "@elizaos/plugin-hyperliquid"],
    ownerScoped: false,
    enabledWithoutRuntimeCapability: false,
    disabledReason: "Load an order-event-capable runtime plugin.",
  },
];

interface Harness {
  request: (
    pathname: string,
  ) => Promise<{ status: number; text: string; json: () => unknown }>;
}

let automationsCompatRoutesImport:
  | Promise<AutomationsCompatRoutesModule>
  | undefined;

function importAutomationsCompatRoutes(): Promise<AutomationsCompatRoutesModule> {
  automationsCompatRoutesImport ??= import(
    "../../src/api/automations-compat-routes"
  );
  return automationsCompatRoutesImport;
}

function buildRequest(pathname: string): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = "GET";
  req.url = pathname;
  req.headers = { host: "127.0.0.1:31337" };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  return req;
}

function buildResponse(): { res: http.ServerResponse; text: () => string } {
  let bodyText = "";
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.statusCode = 200;
  res.setHeader = () => res;
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") bodyText += chunk;
    else if (chunk) bodyText += chunk.toString("utf8");
    return res;
  }) as typeof res.end;
  return { res, text: () => bodyText };
}

async function startApiHarness(state: CompatRuntimeState): Promise<Harness> {
  const { handleAutomationsCompatRoutes } =
    await importAutomationsCompatRoutes();

  return {
    request: async (pathname: string) => {
      const req = buildRequest(pathname);
      const { res, text } = buildResponse();
      const handled = await handleAutomationsCompatRoutes(req, res, state);
      if (!handled) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "not-found" }));
      }
      const bodyText = text();
      return {
        status: res.statusCode,
        text: bodyText,
        json: () => JSON.parse(bodyText) as unknown,
      };
    },
  };
}

function buildRuntimeStub() {
  return {
    character: { name: "Eliza" },
    actions: [
      {
        name: "CODE_TASK",
        description: "Run a coding agent task.",
        // Mirror the real coding-delegation action's classification tags
        // (tasksAction in plugin-agent-orchestrator) so classifyRuntimeActionNode
        // surfaces this as an "agent" node rather than a plain "action".
        tags: ["domain:agent-orchestration", "capability:delegate"],
      },
      {
        name: "MESSAGE",
        description: "Send, read, search, or manage messages.",
      },
    ],
    providers: [
      {
        name: "recent-conversations",
        description: "Browse recent conversation context.",
      },
    ],
    getSetting: vi.fn((key: string) =>
      key === "GITHUB_TOKEN" ? "ghp_test_token" : undefined,
    ),
    getTasks: vi.fn(async () => [
      {
        id: "task-1",
        name: "Inbox triage",
        description: "Clear my inbox and create follow-ups.",
        tags: [],
        isCompleted: false,
        updatedAt: Date.parse("2026-04-17T10:00:00Z"),
      },
    ]),
    getRooms: vi.fn(async () => [
      {
        id: "room-task-1",
        name: "Inbox triage",
        updatedAt: "2026-04-17T12:00:00Z",
        metadata: {
          webConversation: {
            conversationId: "conv-task-1",
            scope: "automation-coordinator",
            automationType: "coordinator_text",
            taskId: "task-1",
            terminalBridgeConversationId: "terminal-1",
          },
        },
      },
      {
        id: "room-trigger-1",
        name: "Morning summary",
        updatedAt: "2026-04-17T13:00:00Z",
        metadata: {
          webConversation: {
            conversationId: "conv-trigger-1",
            scope: "automation-coordinator",
            automationType: "coordinator_text",
            triggerId: "trigger-1",
            terminalBridgeConversationId: "terminal-1",
          },
        },
      },
      {
        id: "room-draft-1",
        name: "Draft workflow",
        updatedAt: "2026-04-17T14:00:00Z",
        metadata: {
          webConversation: {
            conversationId: "conv-draft-1",
            scope: "automation-workflow-draft",
            automationType: "workflow_service",
            draftId: "draft-1",
            terminalBridgeConversationId: "terminal-1",
          },
        },
      },
      {
        id: "room-wf-1",
        name: "Daily report workflow",
        updatedAt: "2026-04-17T15:00:00Z",
        metadata: {
          webConversation: {
            conversationId: "conv-wf-1",
            scope: "automation-workflow",
            automationType: "workflow_service",
            workflowId: "wf-1",
            workflowName: "Daily report workflow",
            terminalBridgeConversationId: "terminal-1",
          },
        },
      },
    ]),
  };
}

function buildRuntimeWithCryptoAutomationCapabilities() {
  const runtime = buildRuntimeStub();
  return {
    ...runtime,
    actions: [
      ...runtime.actions,
      {
        name: "HYPERLIQUID_ACTION",
        description: "Manage Hyperliquid automation intents.",
      },
    ],
    plugins: [{ name: "evm" }, { name: "chain_solana" }],
  };
}

describe("automations compat routes", () => {
  let harness: Harness;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ELIZA_API_TOKEN;
    delete process.env.EVM_PRIVATE_KEY;
    delete process.env.SOLANA_PRIVATE_KEY;
    delete process.env.POLYMARKET_PRIVATE_KEY;

    ensureRouteAuthorizedMock.mockResolvedValue(true);

    registerAutomationNodeContributor("test-lifeops", () => [
      {
        id: "lifeops:gmail",
        label: "Gmail",
        description:
          "Owner-scoped Gmail triage, drafting, and send operations.",
        class: "integration",
        source: "lifeops",
        backingCapability: "lifeops:gmail",
        ownerScoped: true,
        requiresSetup: true,
        availability: "enabled",
      },
      {
        id: "lifeops:telegram",
        label: "Telegram",
        description: "Owner-scoped Telegram account messaging.",
        class: "integration",
        source: "lifeops",
        backingCapability: "lifeops:telegram",
        ownerScoped: true,
        requiresSetup: true,
        availability: "disabled",
        disabledReason: "Connect the owner Telegram account.",
      },
    ]);
  });

  afterEach(async () => {
    delete process.env.EVM_PRIVATE_KEY;
    delete process.env.SOLANA_PRIVATE_KEY;
    delete process.env.POLYMARKET_PRIVATE_KEY;
    clearAutomationNodeContributorsForTests();
  });

  it("does not claim GET /api/automations; plugin-workflow owns the list", async () => {
    harness = await startApiHarness({
      current: buildRuntimeStub() as never,
      pendingAgentName: null,
      pendingRestartReasons: [],
    });

    const response = await harness.request("/api/automations");
    expect(response.status).toBe(404);
  });

  it("GET /api/automations/nodes returns enabled and disabled runtime and LifeOps nodes", async () => {
    harness = await startApiHarness({
      current: buildRuntimeStub() as never,
      pendingAgentName: null,
      pendingRestartReasons: [],
    });

    const response = await harness.request("/api/automations/nodes");
    expect(response.status).toBe(200);
    const body = response.json() as {
      nodes: Array<{
        id: string;
        class: string;
        source: string;
        availability: string;
        ownerScoped: boolean;
        disabledReason?: string;
      }>;
      summary: {
        total: number;
        enabled: number;
        disabled: number;
      };
    };

    expect(body.summary.total).toBe(body.nodes.length);
    expect(body.summary.enabled).toBeGreaterThan(0);
    expect(body.summary.disabled).toBeGreaterThan(0);

    expect(body.nodes).toContainEqual(
      expect.objectContaining({
        id: "action:CODE_TASK",
        class: "agent",
        source: "runtime_action",
        availability: "enabled",
      }),
    );
    expect(body.nodes).not.toContainEqual(
      expect.objectContaining({
        id: "provider:recent-conversations",
      }),
    );
    expect(body.nodes).not.toContainEqual(
      expect.objectContaining({
        id: "provider:relevant-conversations",
      }),
    );
    expect(body.nodes).toContainEqual(
      expect.objectContaining({
        id: "lifeops:gmail",
        class: "integration",
        source: "lifeops",
        ownerScoped: true,
        availability: "enabled",
      }),
    );
    expect(body.nodes).toContainEqual(
      expect.objectContaining({
        id: "lifeops:telegram",
        class: "integration",
        source: "lifeops",
        ownerScoped: true,
        availability: "disabled",
        disabledReason: "Connect the owner Telegram account.",
      }),
    );
    expect(body.nodes).toContainEqual(
      expect.objectContaining({
        id: "trigger:order.schedule",
        class: "trigger",
        source: "static_catalog",
        ownerScoped: false,
        availability: "enabled",
      }),
    );

    // Crypto nodes are owned by their plugins (plugin-wallet / plugin-hyperliquid)
    // and only appear when those plugins register a contributor. With none
    // registered here, they must be absent from the app-core static catalog.
    for (const id of [
      "crypto:evm.swap",
      "crypto:evm.bridge",
      "crypto:solana.swap",
      "crypto:hyperliquid.action",
      "trigger:order.event",
    ]) {
      expect(body.nodes.map((node) => node.id)).not.toContain(id);
    }
  });

  it("drains crypto contributor nodes registered by owning plugins", async () => {
    // Mirror how plugin-wallet / plugin-hyperliquid contribute their nodes: a
    // registered contributor turns runtime-capability specs into descriptors.
    registerAutomationNodeContributor("crypto-plugins", ({ runtime }) =>
      buildRuntimeCapabilityNodes(CRYPTO_CONTRIBUTOR_SPECS, runtime),
    );

    harness = await startApiHarness({
      current: buildRuntimeWithCryptoAutomationCapabilities() as never,
      pendingAgentName: null,
      pendingRestartReasons: [],
    });

    const response = await harness.request("/api/automations/nodes");
    expect(response.status).toBe(200);
    const body = response.json() as {
      nodes: Array<{ id: string; availability: string }>;
    };

    for (const id of [
      "crypto:evm.swap",
      "crypto:evm.bridge",
      "crypto:solana.swap",
      "crypto:hyperliquid.action",
      "trigger:order.event",
    ]) {
      expect(body.nodes).toContainEqual(
        expect.objectContaining({ id, availability: "enabled" }),
      );
    }
  });

  it("keeps crypto contributor nodes disabled when their capability is absent", async () => {
    registerAutomationNodeContributor("crypto-plugins", ({ runtime }) =>
      buildRuntimeCapabilityNodes(CRYPTO_CONTRIBUTOR_SPECS, runtime),
    );

    harness = await startApiHarness({
      current: buildRuntimeStub() as never,
      pendingAgentName: null,
      pendingRestartReasons: [],
    });

    const response = await harness.request("/api/automations/nodes");
    expect(response.status).toBe(200);
    const body = response.json() as {
      nodes: Array<{
        id: string;
        availability: string;
        disabledReason?: string;
      }>;
    };

    expect(body.nodes).toContainEqual(
      expect.objectContaining({
        id: "crypto:evm.swap",
        availability: "disabled",
        disabledReason: "Load the EVM plugin with swap support.",
      }),
    );
  });

  it("does not leak crypto secrets in the automation node catalog", async () => {
    process.env.EVM_PRIVATE_KEY = `0x${"11".repeat(32)}`;
    process.env.SOLANA_PRIVATE_KEY = "solana-secret-test-key";
    process.env.POLYMARKET_PRIVATE_KEY = "polymarket-secret-test-key";

    harness = await startApiHarness({
      current: buildRuntimeStub() as never,
      pendingAgentName: null,
      pendingRestartReasons: [],
    });

    const response = await harness.request("/api/automations/nodes");
    expect(response.status).toBe(200);
    const payload = response.text;

    expect(payload).not.toContain(process.env.EVM_PRIVATE_KEY);
    expect(payload).not.toContain(process.env.SOLANA_PRIVATE_KEY);
    expect(payload).not.toContain(process.env.POLYMARKET_PRIVATE_KEY);
    expect(payload).not.toContain("ghp_test_token");
  });
});
