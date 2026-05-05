import type { GenerateTextParams, IAgentRuntime, Plugin } from "@elizaos/core";
import { ModelType } from "@elizaos/core";

const elizaKeywords = [
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
    response: "That's wonderful! What's making you happy?",
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
    response: "Let me think about that. What does it mean to you?",
  },
  { pattern: /\bcan\b/i, response: "What makes you ask about that?" },
  { pattern: /\byou\b/i, response: "We were talking about you, not me." },
  { pattern: /\bI am\b/i, response: "How long have you been like that?" },
  { pattern: /\bI\b/i, response: "Tell me more about yourself." },
  { pattern: /.*/, response: "Please go on." },
];

function extractUserMessage(prompt: string): string {
  const match = prompt.match(/(?:User|Human|You):\s*(.+?)(?:\n|$)/i);
  return match ? match[1].trim() : prompt.trim();
}

function generateElizaResponse(input: string): string {
  for (const keyword of elizaKeywords) {
    if (keyword.pattern.test(input)) {
      return keyword.response;
    }
  }
  return "Please go on.";
}

async function handle(
  _runtime: IAgentRuntime,
  params: GenerateTextParams,
): Promise<string> {
  const input = extractUserMessage(params.prompt);
  const reply = generateElizaResponse(input);

  return [
    "thought: Responding.",
    "actions: REPLY",
    "providers:",
    `text: ${reply}`,
  ].join("\n");
}

export const elizaClassicToonPlugin: Plugin = {
  name: "eliza-classic-toon",
  description: "Wrap ELIZA classic responses in elizaOS TOON format",
  priority: 200,
  models: {
    [ModelType.TEXT_LARGE]: handle,
    [ModelType.TEXT_SMALL]: handle,
  },
};
