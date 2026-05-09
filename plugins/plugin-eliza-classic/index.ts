import type { GenerateTextParams, IAgentRuntime, Plugin } from "@elizaos/core";
import { ModelType } from "@elizaos/core";

const responses = [
  { pattern: /\bmother\b/i, response: "Tell me more about your family." },
  {
    pattern: /\bfather\b/i,
    response: "How does that make you feel about your father?",
  },
  { pattern: /\bfeel\b/i, response: "Do you often feel this way?" },
  { pattern: /\bthink\b/i, response: "Why do you think that?" },
  { pattern: /\bwant\b/i, response: "What would it mean if you got that?" },
  {
    pattern: /\bsad\b/i,
    response: "I'm sorry to hear you're feeling sad. Can you tell me more?",
  },
  {
    pattern: /\bhappy\b/i,
    response: "That's wonderful. What's making you happy?",
  },
  { pattern: /\byes\b/i, response: "You seem certain. Why is that?" },
  { pattern: /\bno\b/i, response: "Why not?" },
  {
    pattern: /\bwhy\b/i,
    response: "That's a good question. What do you think?",
  },
  { pattern: /\bhow\b/i, response: "What approach would you suggest?" },
  {
    pattern: /\bwhat\b/i,
    response: "What does that question mean to you?",
  },
  { pattern: /\bcan\b/i, response: "What makes you ask about that?" },
  { pattern: /\byou\b/i, response: "We were talking about you, not me." },
  { pattern: /\bI am\b/i, response: "How long have you been like that?" },
  { pattern: /\bI\b/i, response: "Tell me more about yourself." },
  { pattern: /.*/, response: "Please go on." },
] as const;

export function getElizaGreeting(): string {
  return "Hello. How are you feeling today?";
}

function extractUserMessage(prompt: string): string {
  const match = prompt.match(/(?:User|Human|You):\s*(.+?)(?:\n|$)/i);
  return match?.[1]?.trim() ?? prompt.trim();
}

export function generateElizaResponse(input: string): string {
  for (const entry of responses) {
    if (entry.pattern.test(input)) return entry.response;
  }
  return "Please go on.";
}

async function handleText(
  _runtime: IAgentRuntime,
  params: GenerateTextParams,
): Promise<string> {
  const reply = generateElizaResponse(extractUserMessage(params.prompt ?? ""));
  return JSON.stringify({
    thought: "Responding with deterministic ELIZA pattern matching.",
    actions: ["REPLY"],
    providers: [],
    text: reply,
    simple: true,
    useKnowledgeProviders: false,
  });
}

async function handleEmbedding(): Promise<number[]> {
  return Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));
}

export const elizaClassicPlugin: Plugin = {
  name: "eliza-classic",
  description: "Deterministic offline ELIZA-style text responses.",
  priority: 200,
  models: {
    [ModelType.TEXT_NANO]: handleText,
    [ModelType.TEXT_LARGE]: handleText,
    [ModelType.TEXT_MEDIUM]: handleText,
    [ModelType.TEXT_SMALL]: handleText,
    [ModelType.TEXT_MEGA]: handleText,
    [ModelType.RESPONSE_HANDLER]: handleText,
    [ModelType.ACTION_PLANNER]: handleText,
    [ModelType.TEXT_COMPLETION]: handleText,
    [ModelType.TEXT_EMBEDDING]: handleEmbedding,
  },
};

export const plugin = elizaClassicPlugin;
export default elizaClassicPlugin;
