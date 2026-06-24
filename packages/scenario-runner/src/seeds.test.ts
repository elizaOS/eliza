import type { AgentRuntime, UUID } from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioSeedStep,
} from "@elizaos/scenario-runner/schema";
import { describe, expect, it, vi } from "vitest";
import { applyScenarioSeedStep } from "./seeds";

type ConnectorContributionForTest = {
  kind: string;
  capabilities: string[];
  modes: Array<"local" | "cloud">;
  describe: { label: string };
  start: () => Promise<void>;
  disconnect: () => Promise<void>;
  verify: () => Promise<boolean>;
  status: () => Promise<{
    state: "ok" | "degraded" | "disconnected";
    message?: string;
    observedAt: string;
  }>;
  send?: (payload: unknown) => Promise<unknown>;
};

type ConnectorRegistryModuleForTest = {
  createConnectorRegistry: () => {
    register: (contribution: ConnectorContributionForTest) => void;
    get: (kind: string) => ConnectorContributionForTest | null;
    list: (filter?: {
      capability?: string;
      mode?: "local" | "cloud";
    }) => ConnectorContributionForTest[];
    byCapability: (capability: string) => ConnectorContributionForTest[];
  };
  getConnectorRegistry: (
    runtime: AgentRuntime,
  ) => ReturnType<
    ConnectorRegistryModuleForTest["createConnectorRegistry"]
  > | null;
  registerConnectorRegistry: (
    runtime: AgentRuntime,
    registry: ReturnType<
      ConnectorRegistryModuleForTest["createConnectorRegistry"]
    >,
  ) => void;
};

async function loadConnectorRegistryForTest(): Promise<ConnectorRegistryModuleForTest> {
  const specifier = new URL(
    "../../../plugins/plugin-personal-assistant/src/lifeops/connectors/registry.ts",
    import.meta.url,
  ).href;
  return import(specifier) as Promise<ConnectorRegistryModuleForTest>;
}

function createSeedContext() {
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001" as UUID,
  } as unknown as AgentRuntime;
  return { runtime, ctx: { runtime } as ScenarioContext };
}

function baseConnector(
  overrides: Partial<ConnectorContributionForTest> = {},
): ConnectorContributionForTest {
  return {
    kind: "telegram",
    capabilities: ["telegram.send"],
    modes: ["local"],
    describe: { label: "Telegram bridge" },
    start: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    verify: vi.fn(async () => true),
    status: vi.fn(async () => ({
      state: "ok" as const,
      observedAt: "2026-01-01T00:00:00.000Z",
    })),
    send: vi.fn(async () => ({ ok: true, messageId: "sent-1" })),
    ...overrides,
  };
}

describe("scenario connector seeds", () => {
  it("registers connectorStatus seeds as degraded connector contributions", async () => {
    const { ctx, runtime } = createSeedContext();
    const { getConnectorRegistry } = await loadConnectorRegistryForTest();

    const result = await applyScenarioSeedStep(ctx, {
      type: "connectorStatus",
      connector: "gmail",
      provider: "Gmail API",
      state: "missing-scope",
      capabilities: ["google.gmail.triage"],
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    } as ScenarioSeedStep);

    expect(result).toBeUndefined();
    const registry = getConnectorRegistry(runtime);
    const connector = registry?.get("gmail");
    expect(connector?.describe.label).toBe("Gmail API");
    expect(connector?.capabilities).toEqual([
      "google.gmail.triage",
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
    await expect(connector?.status()).resolves.toMatchObject({
      state: "degraded",
      message: "Gmail API seeded missing scope",
    });
  });

  it("overrides existing connector auth status and send failures", async () => {
    const { ctx, runtime } = createSeedContext();
    const {
      createConnectorRegistry,
      getConnectorRegistry,
      registerConnectorRegistry,
    } = await loadConnectorRegistryForTest();
    const base = createConnectorRegistry();
    base.register(baseConnector());
    registerConnectorRegistry(runtime, base);

    await applyScenarioSeedStep(ctx, {
      type: "connectorAuthSession",
      connector: "telegram",
      provider: "Telegram bridge",
      state: "auth-expired",
    } as ScenarioSeedStep);

    const connector = getConnectorRegistry(runtime)?.get("telegram");
    await expect(connector?.status()).resolves.toMatchObject({
      state: "disconnected",
      message: "Telegram bridge seeded auth expired",
    });
    await expect(connector?.send?.({ text: "hello" })).resolves.toMatchObject({
      ok: false,
      reason: "auth_expired",
      userActionable: true,
    });
  });

  it("limits transportFault failures before delegating to the base sender", async () => {
    const { ctx, runtime } = createSeedContext();
    const {
      createConnectorRegistry,
      getConnectorRegistry,
      registerConnectorRegistry,
    } = await loadConnectorRegistryForTest();
    const base = createConnectorRegistry();
    base.register(
      baseConnector({
        kind: "whatsapp",
        capabilities: ["whatsapp.send"],
        describe: { label: "WhatsApp bridge" },
      }),
    );
    registerConnectorRegistry(runtime, base);

    await applyScenarioSeedStep(ctx, {
      type: "transportFault",
      connector: "whatsapp",
      provider: "WhatsApp bridge",
      state: "rate-limited",
      limit: 1,
    } as ScenarioSeedStep);

    const connector = getConnectorRegistry(runtime)?.get("whatsapp");
    await expect(connector?.status()).resolves.toMatchObject({
      state: "degraded",
      message: "WhatsApp bridge seeded rate limited",
    });
    await expect(connector?.send?.({ text: "first" })).resolves.toMatchObject({
      ok: false,
      reason: "rate_limited",
      retryAfterMinutes: 5,
      userActionable: false,
    });
    await expect(connector?.send?.({ text: "second" })).resolves.toMatchObject({
      ok: true,
      messageId: "sent-1",
    });
  });
});
