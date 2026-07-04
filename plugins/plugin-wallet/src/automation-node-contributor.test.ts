/**
 * Covers `registerWalletAutomationNodeContributor`'s node availability logic
 * (disabled by default, enabled once the wallet plugin or a matching action
 * is present) against a hand-built runtime context — no real agent runtime.
 */
import {
  type AutomationNodeContributorContext,
  clearAutomationNodeContributorsForTests,
  listAutomationNodeContributors,
} from "@elizaos/app-core/api/automation-node-contributors";
import { afterEach, describe, expect, it } from "vitest";
import { registerWalletAutomationNodeContributor } from "./automation-node-contributor";

function context(
  runtime: Partial<{
    actions: Array<{ name: string; similes?: string[] }>;
    plugins: Array<{ name: string }>;
  }>,
): AutomationNodeContributorContext {
  return {
    runtime: { actions: [], plugins: [], ...runtime } as never,
    config: {} as never,
    agentName: "Eliza",
    adminEntityId: "admin" as never,
  };
}

const WALLET_NODE_IDS = [
  "crypto:evm.swap",
  "crypto:evm.bridge",
  "crypto:solana.swap",
];

describe("plugin-wallet automation node contributor", () => {
  afterEach(() => {
    clearAutomationNodeContributorsForTests();
  });

  it("registers exactly one wallet contributor", () => {
    registerWalletAutomationNodeContributor();
    expect(listAutomationNodeContributors()).toHaveLength(1);
  });

  it("emits disabled wallet nodes when no wallet capability is loaded", async () => {
    registerWalletAutomationNodeContributor();
    const [contributor] = listAutomationNodeContributors();
    const nodes = await contributor(context({}));

    expect(nodes.map((node) => node.id)).toEqual(WALLET_NODE_IDS);
    expect(nodes.every((node) => node.availability === "disabled")).toBe(true);
    expect(nodes.every((node) => node.source === "static_catalog")).toBe(true);
    expect(nodes.every((node) => node.ownerScoped)).toBe(true);
    expect(
      nodes.find((node) => node.id === "crypto:evm.swap")?.disabledReason,
    ).toBe("Load the EVM plugin with swap support.");
  });

  it("enables all wallet nodes when the wallet plugin is loaded", async () => {
    registerWalletAutomationNodeContributor();
    const [contributor] = listAutomationNodeContributors();
    const nodes = await contributor(context({ plugins: [{ name: "wallet" }] }));

    expect(nodes.map((node) => node.id)).toEqual(WALLET_NODE_IDS);
    expect(nodes.every((node) => node.availability === "enabled")).toBe(true);
    expect(nodes.every((node) => node.disabledReason === undefined)).toBe(true);
  });

  it("enables the solana node when a solana swap action is registered", async () => {
    registerWalletAutomationNodeContributor();
    const [contributor] = listAutomationNodeContributors();
    const nodes = await contributor(
      context({ actions: [{ name: "SWAP_SOLANA" }] }),
    );

    expect(
      nodes.find((node) => node.id === "crypto:solana.swap")?.availability,
    ).toBe("enabled");
    expect(
      nodes.find((node) => node.id === "crypto:evm.swap")?.availability,
    ).toBe("disabled");
  });
});
