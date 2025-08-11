import { ElizaOS, Agent, Inference } from "../lib/core";

const elizaOS = new ElizaOS();

const agent = new Agent({
  model: Inference.getModel("gpt-5-mini"),
});

const response = await agent.generate({
  prompt: "Hello, tell me a random joke.",
});

console.log(response.text);
