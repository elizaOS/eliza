/** Proves adapters cannot narrow mandatory provider scenarios with explicit selections. */

import { describe, expect, test } from "bun:test";
import {
  type ProviderContractCapability,
  type ProviderContractObservation,
  type ProviderContractProfile,
  type ProviderContractScenario,
  requiredProviderContractScenarios,
  runProviderAdapterConformance,
} from "../../src/provider-contract";

function passingScenario(
  scenario: ProviderContractScenario,
): () => Promise<ProviderContractObservation> {
  return async () => ({
    scenario,
    status: "passed",
    detail: `${scenario} executed`,
    ...(scenario === "opaque-connection-id"
      ? { connectionId: "conn_0123456789abcdef" }
      : {}),
    ...(scenario === "write-policy-receipt" ||
    scenario === "irreversible-policy-receipt"
      ? { receiptId: `receipt_${scenario}` }
      : {}),
  });
}

async function expectMandatoryScenario(
  capabilities: readonly ProviderContractCapability[],
  omitted: ProviderContractScenario,
  profile: ProviderContractProfile = "outbound-http",
): Promise<void> {
  const scenarios = Object.fromEntries(
    requiredProviderContractScenarios(capabilities, profile)
      .filter((scenario) => scenario !== omitted)
      .map((scenario) => [scenario, passingScenario(scenario)]),
  );
  await expect(
    runProviderAdapterConformance({
      adapterName: `adversarial-${omitted}`,
      profile,
      capabilities,
      requiredScenarios: ["success"],
      scenarios,
    }),
  ).rejects.toThrow(`missing provider contract scenarios: ${omitted}`);
}

describe("provider conformance mandatory scenarios", () => {
  test.each([
    [["http-read"] as const, "connection-reset" as const],
    [["http-read"] as const, "opaque-connection-id" as const],
    [["http-read"] as const, "read-policy" as const],
    [["http-write"] as const, "write-policy-receipt" as const],
    [["irreversible-write"] as const, "irreversible-policy-receipt" as const],
  ])("does not allow %s to omit %s", async (capabilities, scenario) => {
    await expectMandatoryScenario(capabilities, scenario);
  });

  test("rejects scenario names outside the canonical catalog", async () => {
    await expect(
      runProviderAdapterConformance({
        adapterName: "unknown-scenario-adapter",
        capabilities: ["http-read"],
        requiredScenarios: ["invented-scenario" as ProviderContractScenario],
        scenarios: {},
      }),
    ).rejects.toThrow(
      "declared unknown provider contract scenarios: invented-scenario",
    );
  });

  test.each([
    "malformed-json" as const,
    "provider-4xx" as const,
    "provider-5xx" as const,
    "read-policy" as const,
    "duplicate-webhook" as const,
    "cross-tenant-denial" as const,
  ])("does not allow the inbound profile to omit %s", async (scenario) => {
    await expectMandatoryScenario(
      ["webhooks", "tenant-isolation"],
      scenario,
      "inbound-webhook",
    );
  });
});
