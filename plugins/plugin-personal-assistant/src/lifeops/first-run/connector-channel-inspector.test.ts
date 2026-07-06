/**
 * Honest first-run channel inspector (#14730). Proves the inspector reads
 * *live* status from the real in-memory ConnectorRegistry — in-process channels
 * are always connected, connector-backed channels reflect the contribution's
 * status(), and an unregistered connector or a throwing status probe yields
 * "unknown" rather than a fabricated "disconnected". Deterministic vitest; the
 * connector contributions are minimal stubs whose status() is scripted per case.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConnectorContribution,
  ConnectorStatus,
} from "../connectors/contract.js";
import {
  createConnectorRegistry,
  registerConnectorRegistry,
} from "../connectors/registry.js";
import { ConnectorChannelInspector } from "./connector-channel-inspector.js";

function stubContribution(
  kind: string,
  status: () => Promise<ConnectorStatus>,
): ConnectorContribution {
  return {
    kind,
    capabilities: [`${kind}.send`],
    modes: ["local"],
    describe: { label: kind },
    start: async () => {},
    disconnect: async () => {},
    verify: async () => true,
    status,
  };
}

function makeRuntime(): {
  runtime: IAgentRuntime;
  reportError: ReturnType<typeof vi.fn>;
} {
  const reportError = vi.fn();
  const runtime = { reportError } as unknown as IAgentRuntime;
  return { runtime, reportError };
}

describe("ConnectorChannelInspector", () => {
  let harness: ReturnType<typeof makeRuntime>;
  let inspector: ConnectorChannelInspector;

  beforeEach(() => {
    harness = makeRuntime();
    const registry = createConnectorRegistry();
    registry.register(
      stubContribution("telegram", async () => ({
        state: "ok",
        observedAt: new Date().toISOString(),
      })),
    );
    registry.register(
      stubContribution("discord", async () => ({
        state: "disconnected",
        observedAt: new Date().toISOString(),
      })),
    );
    registerConnectorRegistry(harness.runtime, registry);
    inspector = new ConnectorChannelInspector(harness.runtime);
  });

  afterEach(() => vi.restoreAllMocks());

  it("treats in-process channels (in_app / push) as connected — no connector edge", async () => {
    expect(await inspector.connectionState("in_app")).toBe("connected");
    expect(await inspector.connectionState("push")).toBe("connected");
  });

  it("reflects a connector that reports state=ok as connected", async () => {
    expect(await inspector.connectionState("telegram")).toBe("connected");
  });

  it("reflects a connector that reports state=disconnected as disconnected", async () => {
    expect(await inspector.connectionState("discord")).toBe("disconnected");
  });

  it("answers 'unknown' — never disconnected — when the connector is unregistered", async () => {
    // "imessage" is a real channel with a connector edge, but no contribution
    // is registered in this harness.
    expect(await inspector.connectionState("imessage")).toBe("unknown");
  });

  it("answers 'unknown' for a channel with no connector edge at all", async () => {
    expect(await inspector.connectionState("not_a_channel")).toBe("unknown");
  });

  it("answers 'unknown' and reports the error when a status probe throws", async () => {
    const registry = createConnectorRegistry();
    registry.register(
      stubContribution("telegram", async () => {
        throw new Error("bridge unreachable");
      }),
    );
    registerConnectorRegistry(harness.runtime, registry);
    const throwingInspector = new ConnectorChannelInspector(harness.runtime);

    expect(await throwingInspector.connectionState("telegram")).toBe("unknown");
    // The failure surfaces observably rather than being silently swallowed.
    expect(harness.reportError).toHaveBeenCalledWith(
      "first-run.channel-inspector",
      expect.any(Error),
      expect.objectContaining({
        channel: "telegram",
        connectorKind: "telegram",
      }),
    );
  });

  it("maps a degraded connector to 'unknown' (reachable but not fully healthy)", async () => {
    const registry = createConnectorRegistry();
    registry.register(
      stubContribution("telegram", async () => ({
        state: "degraded",
        observedAt: new Date().toISOString(),
      })),
    );
    registerConnectorRegistry(harness.runtime, registry);
    const degradedInspector = new ConnectorChannelInspector(harness.runtime);
    expect(await degradedInspector.connectionState("telegram")).toBe("unknown");
  });
});
