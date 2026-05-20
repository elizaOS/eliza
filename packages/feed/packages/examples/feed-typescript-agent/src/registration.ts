/**
 * Agent0 Registration
 *
 * Handles agent registration with Agent0 SDK (ERC-8004)
 */

import fs from "node:fs";
import { SDK } from "agent0-sdk";
import { Wallet } from "ethers";

const IDENTITY_FILE = "./agent-identity.json";

export interface AgentIdentity {
  tokenId: number;
  address: string;
  agentId: string;
  metadataCID?: string;
  txHash?: string;
}

/**
 * Register agent with Agent0 or load existing identity
 */
export async function registerAgent(): Promise<AgentIdentity> {
  // Check if already registered
  if (fs.existsSync(IDENTITY_FILE)) {
    console.log("📂 Found existing identity, loading...");
    const identity = JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf-8"));
    return identity;
  }

  console.log("🆕 No existing identity, registering new agent...");

  // Initialize Agent0 SDK
  const sdk = new SDK({
    chainId: process.env.AGENT0_NETWORK === "mainnet" ? 1 : 11155111, // Ethereum Mainnet or Sepolia
    rpcUrl: process.env.AGENT0_RPC_URL!,
    signer: process.env.AGENT0_PRIVATE_KEY!,
    ipfs: "node",
    subgraphUrl: process.env.AGENT0_SUBGRAPH_URL,
  });

  // Create agent
  const agent = sdk.createAgent(
    process.env.AGENT_NAME || "Autonomous Feed Agent",
    process.env.AGENT_DESCRIPTION || "AI agent for Feed prediction markets",
    undefined, // Optional image URL
  );

  // Configure agent
  const strategy = process.env.AGENT_STRATEGY || "balanced";
  const capabilities = {
    strategies: [strategy, "autonomous-trading", "social-interaction"],
    markets: ["prediction", "perp", "crypto"],
    actions: ["trade", "post", "comment", "chat"],
    version: "1.0.0",
    platform: "feed",
    userType: "agent",
    x402Support: false,
  };

  agent.setMetadata({ capabilities, strategy });
  agent.setActive(true);

  // Set A2A endpoint (Feed A2A server)
  const feedA2AUrl = process.env.FEED_API_URL || "http://localhost:3000";
  await agent.setA2A(`${feedA2AUrl}/a2a`, "1.0.0", false);

  // Register on-chain
  console.log("⛓️  Registering on-chain...");
  const txHandle = await agent.registerIPFS();
  await txHandle.waitMined();

  console.log("✅ Registration complete!");
  console.log(`   Token ID: ${agent.agentId ?? "unknown"}`);
  console.log(`   Metadata: ${agent.agentURI ?? "unknown"}`);

  // Parse agent ID
  if (!agent.agentId) {
    throw new Error("Agent0 registration did not return an agentId");
  }
  const parts = agent.agentId.split(":");
  const tokenId = Number.parseInt(parts[1]!, 10);

  // Get wallet address from private key
  const wallet = new Wallet(process.env.AGENT0_PRIVATE_KEY!);

  // Save identity
  const identity: AgentIdentity = {
    tokenId,
    address: wallet.address,
    agentId: agent.agentId,
    metadataCID: agent.agentURI?.replace("ipfs://", ""),
  };

  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2));
  console.log(`💾 Identity saved to ${IDENTITY_FILE}`);

  return identity;
}

// Allow running standalone
if (import.meta.main) {
  registerAgent()
    .then((identity) => {
      console.log("\n✅ Agent registered successfully!");
      console.log(JSON.stringify(identity, null, 2));
      process.exit(0);
    })
    .catch((error) => {
      console.error("❌ Registration failed:", error);
      process.exit(1);
    });
}
