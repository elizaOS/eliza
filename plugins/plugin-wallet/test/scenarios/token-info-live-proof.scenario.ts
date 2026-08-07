/**
 * Exercises wallet token discovery through a live model and the public
 * DexScreener service so required-service readiness is proven on the real path.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

// Public USDC ERC-20 contract address on Ethereum mainnet — not a credential.
const TOKEN_ADDRESS = "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // gitleaks:allow

export default scenario({
  lane: "live-only",
  id: "wallet.token-info-live-proof",
  title: "Wallet token info through live Cerebras and DexScreener",
  domain: "wallet",
  tags: ["wallet", "live-model", "live-api"],
  description:
    "Routes a USDC lookup through the live model and the wallet plugin's public DexScreener service.",
  requires: {
    plugins: ["@elizaos/plugin-wallet"],
    services: ["token-info"],
  },
  isolation: "per-scenario",
  rooms: [
    { id: "main", source: "dashboard", channelType: "DM", title: "Wallet" },
  ],
  turns: [
    {
      kind: "message",
      name: "lookup",
      text: `Use the WALLET tool to fetch current DexScreener token information for USDC at ${TOKEN_ADDRESS}.`,
      content: { action: "token_info", address: TOKEN_ADDRESS },
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find(
          (candidate) => candidate.actionName === "WALLET_TOKEN_INFO",
        );
        if (!call) {
          return `Expected WALLET_TOKEN_INFO but got: ${turn.actionsCalled
            .map((candidate) => candidate.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `WALLET_TOKEN_INFO failed: ${call.error?.message ?? call.result?.text ?? "unknown error"}`;
        }
        const data = call.result.data as
          | { subaction?: unknown; pairs?: unknown }
          | undefined;
        if (data?.subaction !== "token_info") {
          return `Expected token_info result, got ${String(data?.subaction)}`;
        }
        if (!Array.isArray(data.pairs) || data.pairs.length === 0) {
          return "DexScreener returned no live USDC pairs";
        }
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "WALLET_TOKEN_INFO",
      status: "success",
      minCount: 1,
    },
  ],
});
