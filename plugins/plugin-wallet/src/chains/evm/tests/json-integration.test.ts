import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseJSONObjectFromText } from "@elizaos/core";
import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

const runJsonLiveTest =
	process.env.ELIZA_LIVE_JSON_TEST === "1" ||
	process.env.ELIZA_LIVE_TEST === "1" ||
	process.env.ELIZA_LIVE_TEST === "1";

let callLLM: (prompt: string) => Promise<string>;
let hasApiKey = false;

try {
	if (runJsonLiveTest && process.env.ANTHROPIC_API_KEY) {
		const { default: Anthropic } = await import("@anthropic-ai/sdk");
		const client = new Anthropic();
		hasApiKey = true;
		callLLM = async (prompt: string) => {
			const msg = await client.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 256,
				messages: [{ role: "user", content: prompt }],
			});
			return msg.content[0].type === "text" ? msg.content[0].text : "";
		};
	} else if (runJsonLiveTest && process.env.OPENAI_API_KEY) {
		const { default: OpenAI } = await import("openai");
		const baseURL = process.env.OPENAI_BASE_URL || undefined;
		const isGroq = baseURL?.includes("groq.com");
		const client = new OpenAI({ baseURL });
		hasApiKey = true;
		callLLM = async (prompt: string) => {
			const resp = await client.chat.completions.create({
				model: isGroq ? "openai/gpt-oss-120b" : "gpt-5-mini",
				max_tokens: 256,
				messages: [{ role: "user", content: prompt }],
			});
			return resp.choices[0]?.message?.content ?? "";
		};
	}
} catch {
	// SDK not available
}

describe.skipIf(!runJsonLiveTest || !hasApiKey)(
	"JSON EVM transfer extraction integration",
	() => {
		test(
			"extracts transfer fields from a user message",
			{ timeout: 30_000 },
			async () => {
				const prompt = `Given the recent messages and wallet information below:

User: Transfer 0.5 ETH to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e on ethereum

ethereum: 10.5 ETH, base: 2.1 ETH

Extract the following information about the requested token transfer:
- Chain to execute on (must be one of the supported chains)
- Amount to transfer (only number without coin symbol, e.g., "0.1")
- Recipient address (must be a valid Ethereum address)
- Token symbol or address (if not a native token transfer)
- Additional data/calldata (if any is included)

Respond using JSON like this:
{
  "fromChain": "chain from ethereum | base | polygon, or empty",
  "amount": "amount as string (e.g. 0.1), or empty",
  "toAddress": "recipient Ethereum address, or empty",
  "token": "token symbol or address (empty for native transfer)",
  "data": "additional calldata hex string, or empty"
}

IMPORTANT: Your response must ONLY contain the JSON object above. No preamble or explanation.`;

				const raw = await callLLM(prompt);
				const parsed = parseJSONObjectFromText(raw) as Record<string, unknown> | null;

				expect(parsed).not.toBeNull();
				expect(String(parsed?.fromChain).toLowerCase()).toContain("ethereum");
				expect(String(parsed?.amount)).toContain("0.5");
				expect(String(parsed?.toAddress).toLowerCase()).toContain(
					"0x742d35cc".toLowerCase(),
				);
			},
		);
	},
);
