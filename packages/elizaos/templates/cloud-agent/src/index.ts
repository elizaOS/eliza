import { AgentRuntime } from "@elizaos/core";

const character = await import("../character.json", { with: { type: "json" } });

const agent = new AgentRuntime({
  character: character.default,
  token: process.env.ELIZA_API_TOKEN,
});

await agent.initialize();
console.log(`Agent ${character.default.name} is running.`);

// Keep alive
await new Promise(() => {});
