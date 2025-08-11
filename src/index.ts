import { ElizaOS, Agent, Inference } from "@/lib/core";
import {
  discordService,
  readChannel,
  listChannels,
} from "../plugins/plugin-discord";
import {
  evmService,
  getWalletAddress,
  getWalletBalance,
  getTokenBalance,
  getEVMChains,
} from "../plugins/plugin-evm";
import { stepCountIs, type Tool } from "ai";

// Initialize ElizaOS
const elizaOS = new ElizaOS();

const tools: Record<string, Tool> = {};

if (process.env.DISCORD_API_TOKEN) {
  discordService.initialize(process.env.DISCORD_API_TOKEN);
  tools.readDiscordChannel = readChannel;
  tools.listDiscordChannels = listChannels;
}

if (process.env.WALLET_PRIVATE_KEY) {
  evmService.initialize({
    walletPrivateKey: process.env.WALLET_PRIVATE_KEY,
    // If you want to customize chains, set EVM_CHAINS like: "base,mainnet"
    chainIds: process.env.EVM_CHAINS
      ?.split(",")
      .map((s) => s.trim()) as Array<string> | undefined,
  });
  tools.getWalletAddress = getWalletAddress;
  tools.getWalletBalance = getWalletBalance;
  tools.getTokenBalance = getTokenBalance;
  tools.getEVMChains = getEVMChains;
}

// Create agent with Discord tools
const agent = new Agent({
  model: Inference.getModel("gpt-5-mini"),
  tools,
  stopWhen: stepCountIs(10),
});

elizaOS.addAgent(agent);

const response = await agent.generate({
  prompt: "Hello, tell me a random joke.",
});

console.log(response.text);

if (process.env.DISCORD_API_TOKEN) {
  // Example of using natural channel names
  const response = await agent.generate({
    prompt: `Summarize the latest messages in core-devs channel in the discord server ID: ${process.env.DISCORD_SERVER_ID}`,
  });

  console.log("Discord channel response:", response.text);
}

if (process.env.WALLET_PRIVATE_KEY) {
  const evmResponse = await agent.generate({
    prompt:
      "Return my EVM wallet address, list configured chains, and show native balances across them in human readable format",
  });
  console.log("EVM wallet response:", evmResponse.text);
}

if (process.env.WALLET_PRIVATE_KEY) {
  const chainsResponse = await agent.generate({
    prompt:
      "List configured EVM chains with their chainId, name, native currency symbol, and explorer URL if available.",
  });
  console.log("EVM chains response:", chainsResponse.text);
}

if (process.env.WALLET_PRIVATE_KEY) {
  const tokenResponse = await agent.generate({
    prompt:
      "Return my ERC20 USDC token balance for base chain; USDC address: 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  });
  console.log("EVM token balance response:", tokenResponse.text);
}
