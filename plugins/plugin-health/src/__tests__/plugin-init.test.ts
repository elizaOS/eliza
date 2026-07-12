/**
 * Exercises the `healthPlugin` entry surface end-to-end: `init` against a
 * runtime carrying the real W1-A/W1-F registry seams (connector, anchor,
 * bus-family, default-pack) and against a bare runtime with none of them,
 * plus the plugin's declared view/evaluator manifest.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type {
  AnchorContribution,
  BusFamilyContribution,
  ConnectorContribution,
} from "../connectors/contract-types.js";
import { getCircadianInsightContract } from "../contracts/circadian.js";
import type { DefaultPack } from "../default-packs/index.js";
import { HEALTH_PLUGIN_NAME, healthPlugin } from "../index.js";

function makeRegistryRuntime() {
  const connectors: ConnectorContribution[] = [];
  const anchors: AnchorContribution[] = [];
  const busFamilies: BusFamilyContribution[] = [];
  const packs: DefaultPack[] = [];
  const runtime = {
    connectorRegistry: {
      register: (c: ConnectorContribution) => {
        connectors.push(c);
      },
      list: () => connectors,
      get: (kind: string) => connectors.find((c) => c.kind === kind) ?? null,
      byCapability: (capability: string) =>
        connectors.filter((c) => c.capabilities.includes(capability)),
    },
    anchorRegistry: {
      register: (a: AnchorContribution) => {
        anchors.push(a);
      },
      list: () => anchors,
      get: (anchorKey: string) =>
        anchors.find((a) => a.anchorKey === anchorKey) ?? null,
    },
    busFamilyRegistry: {
      register: (f: BusFamilyContribution) => {
        busFamilies.push(f);
      },
      list: () => busFamilies,
    },
    defaultPackRegistry: {
      register: (pack: DefaultPack) => {
        packs.push(pack);
      },
      get: (key: string) => packs.find((p) => p.key === key) ?? null,
      list: () => packs,
    },
  };
  return { runtime, connectors, anchors, busFamilies, packs };
}

describe("healthPlugin init", () => {
  it("declares the health view and routing evaluator without direct actions", () => {
    expect(healthPlugin.name).toBe(HEALTH_PLUGIN_NAME);
    expect(healthPlugin.actions).toEqual([]);
    expect(healthPlugin.providers).toEqual([]);
    expect(healthPlugin.services).toEqual([]);
    expect(
      healthPlugin.responseHandlerEvaluators?.map((e) => e.name),
    ).toContain("health.owner-telemetry-routing");
    const view = healthPlugin.views?.[0];
    expect(view).toMatchObject({
      id: "health",
      path: "/health",
      componentExport: "HealthView",
      relatedActions: ["OWNER_HEALTH", "OWNER_SCREENTIME"],
    });
  });

  it("registers connectors, anchors, bus families, packs, and the circadian contract on init", async () => {
    const { runtime, connectors, anchors, busFamilies, packs } =
      makeRegistryRuntime();

    await healthPlugin.init?.({}, runtime as unknown as IAgentRuntime);

    expect(connectors.map((c) => c.kind)).toEqual([
      "apple_health",
      "google_fit",
      "strava",
      "fitbit",
      "withings",
      "oura",
    ]);
    expect(anchors.map((a) => a.anchorKey)).toEqual([
      "wake.observed",
      "wake.confirmed",
      "bedtime.target",
      "nap.start",
    ]);
    expect(busFamilies).toHaveLength(8);
    expect(packs.map((p) => p.key)).toEqual([
      "bedtime",
      "wake-up",
      "sleep-recap",
    ]);
    const contract = getCircadianInsightContract(
      runtime as unknown as IAgentRuntime,
    );
    expect(contract).not.toBeNull();
  });

  it("init is idempotent for default packs already registered", async () => {
    const { runtime, packs } = makeRegistryRuntime();
    await healthPlugin.init?.({}, runtime as unknown as IAgentRuntime);
    await healthPlugin.init?.({}, runtime as unknown as IAgentRuntime);
    expect(packs.map((p) => p.key)).toEqual([
      "bedtime",
      "wake-up",
      "sleep-recap",
    ]);
  });

  it("init tolerates a runtime without any Wave-1 registries (soft-dep posture)", async () => {
    const bare = {} as IAgentRuntime;
    await expect(healthPlugin.init?.({}, bare)).resolves.toBeUndefined();
    expect(getCircadianInsightContract(bare)).not.toBeNull();
  });
});
