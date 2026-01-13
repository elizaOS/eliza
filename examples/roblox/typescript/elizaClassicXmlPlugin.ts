import type { GenerateTextParams, IAgentRuntime, Plugin } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { generateElizaResponse } from "@elizaos/plugin-eliza-classic";

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function extractUserMessage(prompt: string): string {
  const match = prompt.match(/(?:User|Human|You):\s*(.+?)(?:\n|$)/i);
  return match ? match[1].trim() : prompt.trim();
}

async function handle(runtime: IAgentRuntime, params: GenerateTextParams): Promise<string> {
  const input = extractUserMessage(params.prompt);
  const reply = generateElizaResponse(input);

  // The elizaOS runtime expects an XML <response> block.
  // Keep it minimal: no actions, just text.
  return [
    "<response>",
    "<thought>Responding.</thought>",
    "<actions>REPLY</actions>",
    "<providers></providers>",
    `<text>${escapeXml(reply)}</text>`,
    "</response>",
  ].join("");
}

export const elizaClassicXmlPlugin: Plugin = {
  name: "eliza-classic-xml",
  description: "Wrap ELIZA classic responses in elizaOS XML format",
  priority: 200,
  models: {
    [ModelType.TEXT_LARGE]: handle,
    [ModelType.TEXT_SMALL]: handle,
  },
};

