/**
 * Covers the custom-LLM gate that decides how document contextualization
 * generates a chunk's context: through the documents pipeline's direct provider
 * client, or through the agent's registered TEXT_LARGE model. The direct-provider
 * branch runs against a local OpenAI-compatible HTTP server, so each assertion
 * observes which real transport handled the request rather than a stubbed
 * predicate. Settings resolution is the behavior under test: runtime settings
 * must drive the branch when the environment is unset, and a blank runtime
 * setting must fall through to the environment instead of reading as "present".
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createMockRuntime, MOCK_AGENT_ID } from "../../testing/mock-runtime";
import type { IAgentRuntime, Memory, UUID } from "../../types";
import { ModelType } from "../../types";
import { processFragmentsSynchronously } from "./document-processor.ts";

const DOCUMENT_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const DOCUMENT_TEXT =
	"Refund requests are processed within five business days of approval.";
const PROVIDER_CONTEXT = "context-from-direct-provider";
const RUNTIME_MODEL_CONTEXT = "context-from-runtime-model";

const SETTING_KEYS = [
	"CTX_DOCUMENTS_ENABLED",
	"TEXT_PROVIDER",
	"TEXT_MODEL",
	"OPENAI_API_KEY",
	"OPENAI_BASE_URL",
	"OPENAI_EMBEDDING_MODEL",
	"TEXT_EMBEDDING_MODEL",
	"EMBEDDING_PROVIDER",
	"RATE_LIMIT_ENABLED",
	"BATCH_EMBEDDINGS",
	"ELIZA_MODEL_GATEWAY_URL",
] as const;

interface ProviderStub {
	baseUrl: string;
	requestCount: () => number;
	close: () => Promise<void>;
}

async function startOpenAiCompatibleServer(): Promise<ProviderStub> {
	let requests = 0;
	const server: Server = createServer((req, res) => {
		requests += 1;
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					id: "chatcmpl-test",
					object: "chat.completion",
					created: 0,
					model: "gpt-test",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: PROVIDER_CONTEXT },
							finish_reason: "stop",
						},
					],
					usage: {
						prompt_tokens: 1,
						completion_tokens: 1,
						total_tokens: 2,
					},
				}),
			);
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requestCount: () => requests,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}

interface Harness {
	runtime: IAgentRuntime;
	savedFragments: Memory[];
	runtimeModelCalls: () => number;
}

function makeHarness(settings: Record<string, string>): Harness {
	const savedFragments: Memory[] = [];
	let runtimeModelCalls = 0;
	const runtime = createMockRuntime({
		getSetting: (key: string) => settings[key] ?? null,
		redactSecrets: (text: string) => text,
		// The direct-provider path wraps generation in a standalone trajectory,
		// which looks for optional recorder services.
		getService: () => null,
		getServicesByType: () => [],
		getModel: (type: string) =>
			type === ModelType.TEXT_EMBEDDING
				? async () => [0.1, 0.2, 0.3]
				: undefined,
		useModel: (async (type: string) => {
			if (type === ModelType.TEXT_EMBEDDING) {
				return [0.1, 0.2, 0.3];
			}
			if (type === ModelType.TEXT_LARGE) {
				runtimeModelCalls += 1;
				return RUNTIME_MODEL_CONTEXT;
			}
			throw new Error(`Unexpected model request: ${type}`);
		}) as IAgentRuntime["useModel"],
		createMemory: async (memory: Memory): Promise<UUID> => {
			savedFragments.push(memory);
			return memory.id as UUID;
		},
	});
	return {
		runtime,
		savedFragments,
		runtimeModelCalls: () => runtimeModelCalls,
	};
}

async function ingest(runtime: IAgentRuntime): Promise<number> {
	return processFragmentsSynchronously({
		runtime,
		documentId: DOCUMENT_ID,
		fullDocumentText: DOCUMENT_TEXT,
		agentId: MOCK_AGENT_ID,
	});
}

function fragmentText(fragments: Memory[]): string {
	const text = fragments[0]?.content?.text;
	if (typeof text !== "string") {
		throw new Error("Expected a persisted fragment with text content");
	}
	return text;
}

describe("document contextualization custom-LLM gate", () => {
	let provider: ProviderStub;
	const savedEnv = new Map<string, string | undefined>();

	beforeEach(async () => {
		provider = await startOpenAiCompatibleServer();
		for (const key of SETTING_KEYS) {
			savedEnv.set(key, process.env[key]);
			delete process.env[key];
		}
		// The pipeline's rate limiter would otherwise pace a single-chunk ingest.
		process.env.RATE_LIMIT_ENABLED = "false";
	});

	afterEach(async () => {
		for (const [key, value] of savedEnv) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		savedEnv.clear();
		await provider.close();
	});

	test("runtime settings alone select the direct provider when the environment is unset", async () => {
		const harness = makeHarness({
			CTX_DOCUMENTS_ENABLED: "true",
			TEXT_PROVIDER: "openai",
			TEXT_MODEL: "gpt-test",
			OPENAI_API_KEY: "runtime-openai-key",
			OPENAI_BASE_URL: provider.baseUrl,
		});

		const saved = await ingest(harness.runtime);

		expect(saved).toBe(1);
		expect(provider.requestCount()).toBe(1);
		expect(harness.runtimeModelCalls()).toBe(0);
		expect(fragmentText(harness.savedFragments)).toContain(PROVIDER_CONTEXT);
	});

	test("a blank runtime setting falls through to the environment value", async () => {
		process.env.TEXT_PROVIDER = "openai";
		process.env.TEXT_MODEL = "gpt-test";
		process.env.OPENAI_API_KEY = "env-openai-key";
		process.env.OPENAI_BASE_URL = provider.baseUrl;

		const harness = makeHarness({
			CTX_DOCUMENTS_ENABLED: "true",
			// A blank runtime alias is unset, not a value that masks the environment.
			TEXT_PROVIDER: "",
			TEXT_MODEL: "   ",
			OPENAI_API_KEY: "",
		});

		const saved = await ingest(harness.runtime);

		expect(saved).toBe(1);
		expect(provider.requestCount()).toBe(1);
		expect(harness.runtimeModelCalls()).toBe(0);
		expect(fragmentText(harness.savedFragments)).toContain(PROVIDER_CONTEXT);
	});

	test("a missing provider key keeps contextualization on the runtime TEXT_LARGE model", async () => {
		const harness = makeHarness({
			CTX_DOCUMENTS_ENABLED: "true",
			TEXT_EMBEDDING_MODEL: "test-embedding",
		});

		const saved = await ingest(harness.runtime);

		expect(saved).toBe(1);
		expect(provider.requestCount()).toBe(0);
		expect(harness.runtimeModelCalls()).toBe(1);
		expect(fragmentText(harness.savedFragments)).toContain(
			RUNTIME_MODEL_CONTEXT,
		);
	});
});
