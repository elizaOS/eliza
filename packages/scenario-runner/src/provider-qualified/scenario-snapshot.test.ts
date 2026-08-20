/**
 * Exercises executable-free serialization for the complete provider catalog
 * and rejects catalog, operation, classification, and byte-canonicality drift.
 */

import { describe, expect, it } from "vitest";
import { PROVIDER_CANARY_SCENARIOS } from "../../../test/scenarios/provider-qualified/_provider-canary-catalog.ts";
import { providerCanaryControllerContract } from "./controller-registry.ts";
import {
  createProviderCanaryScenarioSnapshot,
  parseProviderCanaryScenarioSnapshot,
} from "./scenario-snapshot.ts";

describe("provider canary scenario snapshots", () => {
  it("round-trips all 13 canonical definitions as deterministic JSON", () => {
    for (const definition of PROVIDER_CANARY_SCENARIOS) {
      const operationKind = providerCanaryControllerContract(
        definition.id,
      ).operationKind;
      const bytes = createProviderCanaryScenarioSnapshot({
        definition,
        operationKind,
      });
      expect(bytes.at(-1)).toBe(10);
      expect(bytes.includes(0)).toBe(false);
      expect(
        parseProviderCanaryScenarioSnapshot({ bytes, operationKind }),
      ).toEqual(definition);
    }
  });

  it("rejects a substituted operation and non-canonical bytes", () => {
    const definition = PROVIDER_CANARY_SCENARIOS[0];
    const bytes = createProviderCanaryScenarioSnapshot({
      definition,
      operationKind: "bluebubbles.message-send",
    });
    expect(() =>
      parseProviderCanaryScenarioSnapshot({
        bytes,
        operationKind: "discord.message-send",
      }),
    ).toThrow(/canonical operation kind/);
    expect(() =>
      parseProviderCanaryScenarioSnapshot({
        bytes: Buffer.from(` ${bytes.toString("utf8")}`),
        operationKind: "bluebubbles.message-send",
      }),
    ).toThrow(/must use canonical JSON/);
  });

  it("rejects unknown fields and qualification-classification drift", () => {
    const definition = structuredClone(PROVIDER_CANARY_SCENARIOS[0]) as Record<
      string,
      unknown
    >;
    expect(() =>
      createProviderCanaryScenarioSnapshot({
        definition: { ...definition, executableHook: "no" } as never,
        operationKind: "bluebubbles.message-send",
      }),
    ).toThrow(/unknown fields/);
    expect(() =>
      createProviderCanaryScenarioSnapshot({
        definition: { ...definition, executionProfile: "simulated" } as never,
        operationKind: "bluebubbles.message-send",
      }),
    ).toThrow(/incompatible evidenceScope|qualification classification/);
  });
});
