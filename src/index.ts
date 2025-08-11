import { ElizaOS, Agent, Inference } from "@/lib/core";
import {
  discordService,
  readChannel,
  listChannels,
} from "../plugins/plugin-discord";
import { stepCountIs, type Tool } from "ai";

// Initialize ElizaOS
const elizaOS = new ElizaOS();

const tools: Record<string, Tool> = {};

if (process.env.DISCORD_API_TOKEN) {
  discordService.initialize(process.env.DISCORD_API_TOKEN);
  tools.readDiscordChannel = readChannel;
  tools.listDiscordChannels = listChannels;
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
