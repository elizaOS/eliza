import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { buildWalletRpcUpdateRequest } from "@elizaos/contracts";
import {
	AgentRuntime,
	createLogger,
	ElizaError,
	flattenRuntimeSettings,
	ModelType,
	mergeDbSettings,
	parseCharacter,
	provisionAgent,
	stringToUuid,
} from "@elizaos/core";
import { wordErrorRate } from "@elizaos/voice";
import { SQLiteDatabaseAdapter } from "./adapter.mjs";

assert.equal(wordErrorRate("published voice", "published voice"), 0);

const failure = new ElizaError("packed consumer failure", {
	code: "PACKED_ERROR",
	context: { source: "consumer" },
});
const { toElizaError } = await import("@elizaos/core");
assert.equal(
	toElizaError(failure),
	failure,
	"normalization preserves the canonical error and its metadata",
);
const { isElizaError, isTimeoutError } = await import("@elizaos/core/protocol");
const hostile = new Proxy(
	{},
	{
		get() {
			throw new Error("untrusted getter");
		},
		getPrototypeOf() {
			throw new Error("untrusted prototype");
		},
	},
);
const revoked = Proxy.revocable({}, {});
revoked.revoke();
const malformed = new Error("original");
Object.defineProperty(malformed, "message", { value: 42 });
for (const value of [hostile, revoked.proxy, malformed, Object.create(null)]) {
	const normalized = toElizaError(value, "PACKED_UNKNOWN");
	assert.equal(normalized.cause, value);
	assert.equal(normalized.code, "PACKED_UNKNOWN");
	assert.equal(typeof normalized.message, "string");
	assert.equal(isElizaError(normalized), true);
	assert.equal(isTimeoutError(value), false);
}
assert.equal(isTimeoutError({ name: "TimeoutError" }), true);
assert.equal(isTimeoutError("request timed out"), true);
// Exercise the public v2 replacement for host composition against real storage.
writeFileSync(
	"character.json",
	JSON.stringify({
		name: "packed-kernel",
		bio: "deterministic package verification",
		settings: { shouldRespondModel: "character-model" },
		secrets: { characterOnly: "fixture-character", shared: "character-top" },
	}),
);
const character = parseCharacter(
	JSON.parse(readFileSync("character.json", "utf8")),
);
const original = structuredClone(character);
const agentId = stringToUuid(character.name);
assert.equal(
	flattenRuntimeSettings(character, {}).shouldRespondModel,
	"character-model",
);
const adapter = SQLiteDatabaseAdapter.create(":memory:", agentId);
await adapter.initialize();
await adapter.createAgents([
	{
		id: agentId,
		name: character.name,
		settings: {
			shouldRespondModel: "database-model",
			defaultTemperature: 0.42,
			secrets: { shared: "database-setting", databaseNested: "fixture-nested" },
		},
		secrets: { shared: "database-top", databaseTop: "fixture-top" },
	},
]);
const merged = await mergeDbSettings(character, adapter, agentId);
assert.deepEqual(
	character,
	original,
	"persisted settings merge must not mutate character input",
);
assert.equal(merged.settings.shouldRespondModel, "character-model");
assert.equal(merged.settings.defaultTemperature, 0.42);
assert.deepEqual(merged.secrets, {
	shared: "character-top",
	databaseTop: "fixture-top",
	databaseNested: "fixture-nested",
	characterOnly: "fixture-character",
});
let calls = 0;
const fixturePlugin = {
	name: "fixture",
	description: "explicit host-selected model",
	models: {
		[ModelType.TEXT_SMALL]: async (_runtime, input) => {
			assert.equal(input.prompt, "Return the fixture value.");
			calls++;
			return "fixture:perfect";
		},
	},
};
const runtime = new AgentRuntime({
	agentId,
	adapter,
	character: merged,
	plugins: [fixturePlugin],
	logLevel: "fatal",
});
try {
	await runtime.initialize({ skipMigrations: true });
	await provisionAgent(runtime, { runMigrations: false });
	assert.equal(runtime.agentId, agentId);
	assert.equal(runtime.getSetting("defaultTemperature"), 0.42);
	assert.equal((await adapter.getEntitiesByIds([agentId]))[0].id, agentId);
	assert.equal((await adapter.getRoomsByIds([agentId]))[0].id, agentId);
	assert.ok(
		(await adapter.getParticipantsForRooms([agentId]))[0].entityIds.includes(
			agentId,
		),
	);
	assert.equal(runtime.messageService, null);
	assert.equal("routes" in runtime, false);
	assert.equal(
		Symbol.for("elizaos.http-runtime") in runtime,
		false,
		"HTTP state is installed explicitly",
	);

	assert.equal("rerankMemories" in runtime, false);
	assert.equal("companionUrl" in runtime, false);
	assert.equal(runtime.actions.length, 0);
	assert.equal(runtime.providers.length, 0);
	assert.equal(
		await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt: "Return the fixture value.",
		}),
		"fixture:perfect",
	);
	assert.equal(calls, 1);
	assert.equal(typeof createLogger().info, "function");
	const publicApi = await import("@elizaos/core");
	assert.equal(
		publicApi.providerPluginMap.OPENAI_API_KEY,
		"@elizaos/plugin-openai",
	);
	assert.equal(
		publicApi.shortIdPluginMap["agent-wallet"],
		"@elizaos/plugin-wallet",
	);
	assert.equal(
		publicApi.getMacPermissionDeepLink("camera"),
		"x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
	);
	const eventProtocol = await import("@elizaos/core/protocol");
	for (const dispatcher of [
		"createNavigateViewEvent",
		"dispatchNavigateViewEvent",
		"dispatchAppEvent",
		"dispatchWindowEvent",
		"dispatchAppEmoteEvent",
		"dispatchElizaCloudStatusUpdated",
	]) {
		assert.equal(
			dispatcher in eventProtocol,
			false,
			`${dispatcher} belongs to the UI host`,
		);
	}
	const navigation = publicApi.normalizeShellNavigateViewPayload({
		viewId: "settings",
		viewType: "gui",
		source: "agent",
		completedActionHandoffId: "handoff-fixture",
	});
	assert.equal(navigation.completedActionHandoffId, "handoff-fixture");
	assert.equal(
		publicApi.normalizeCompletedActionHandoffId("../invalid"),
		undefined,
	);
	assert.equal(
		publicApi.createShellNavigateViewWsFrame(navigation).type,
		publicApi.SHELL_NAVIGATE_VIEW_WS_EVENT,
	);
	const boundaryRecord = new (class BoundaryRecord {
		value = 1;
	})();
	assert.equal(publicApi.asObjectRecord(boundaryRecord), boundaryRecord);
	assert.equal(publicApi.asRecord(boundaryRecord), null);
	const exportPrompt = `${"complete model request 🟠 ".repeat(12000)}FINAL-REQUEST`;
	const exportResponse = "complete response with final reference";
	const exportRecord = {
		trajectoryId: "packed-trajectory",
		agentId,
		startTime: 1,
		metadata: { source: "packed-consumer" },
		steps: [
			{
				stepId: "packed-step",
				timestamp: 1,
				llmCalls: [
					{
						callId: "packed-call",
						model: "fixture",
						systemPrompt: "Preserve the request.",
						userPrompt: exportPrompt,
						response: exportResponse,
					},
				],
			},
		],
	};
	for (const format of ["json", "jsonl"]) {
		const exported = publicApi.serializeTrajectoryExport([exportRecord], {
			format,
		});
		const parsed = JSON.parse(exported.data);
		const row = Array.isArray(parsed) ? parsed[0] : parsed;
		assert.equal(row.request.prompt, exportPrompt);
		assert.equal(row.response.text, exportResponse);
	}
	assert.throws(
		() =>
			publicApi.serializeTrajectoryExport(
				[{ ...exportRecord, steps: undefined, stepsJson: "{invalid" }],
				{ format: "jsonl" },
			),
		publicApi.ElizaError,
	);
	const keywordMemory = {
		id: "keyword",
		content: { text: "automobile receipt" },
	};
	const semanticMemory = { id: "semantic", content: { text: "bought a car" } };
	const attachmentMemory = { id: "attachment", content: {} };
	assert.deepEqual(
		publicApi.rerankMemories("automobile", [
			semanticMemory,
			attachmentMemory,
			keywordMemory,
		]),
		[keywordMemory, semanticMemory, attachmentMemory],
	);
	assert.equal(
		new publicApi.BM25([
			{ title: "receipt", content: "automobile receipt" },
		]).search("automobile", 1)[0].index,
		0,
	);

	publicApi.registerCuratedApp({
		slug: "packed-core-fixture",
		canonicalName: "@elizaos/plugin-packed-core-fixture",
		aliases: ["packed fixture"],
	});
	assert.equal(
		publicApi.getElizaCuratedAppDefinition("packed fixture")?.canonicalName,
		"@elizaos/plugin-packed-core-fixture",
	);
	assert.ok(
		publicApi
			.getCuratedAppDefinitions()
			.some((entry) => entry.slug === "packed-core-fixture"),
	);
	const registry = publicApi.loadRegistry();
	assert.ok(
		publicApi.getApps(registry).length > 0,
		"packed root reads the shipped first-party catalog",
	);

	const walletFields = Object.freeze({
		ALCHEMY_API_KEY: "  fixture-alchemy  ",
		INFURA_API_KEY: "fixture-retired",
	});
	const walletProviders = Object.freeze({
		evm: "ALCHEMY",
		bsc: "eliza-cloud",
		solana: "eliza-cloud",
	});
	assert.deepEqual(
		buildWalletRpcUpdateRequest({
			rpcFieldValues: walletFields,
			selectedProviders: walletProviders,
			selectedNetwork: "testnet",
		}),
		{
			selections: { evm: "alchemy", bsc: "eliza-cloud", solana: "eliza-cloud" },
			walletNetwork: "testnet",
			credentials: { ALCHEMY_API_KEY: "fixture-alchemy", INFURA_API_KEY: "" },
		},
	);
	assert.equal(
		walletFields.ALCHEMY_API_KEY,
		"  fixture-alchemy  ",
		"request construction preserves its input",
	);

	for (const retired of [
		"loadCharacters",
		"createRuntimes",
		"mergeSettingsInto",
	]) {
		assert.equal(
			retired in publicApi,
			false,
			`${retired} is retired from the v2 public API`,
		);
	}
	for (const mediaApi of [
		"fetchRemoteMedia",
		"detectMime",
		"describeImageCached",
		"resolveAttachmentBytes",
	]) {
		assert.equal(
			typeof publicApi[mediaApi],
			"function",
			`${mediaApi} is available from the public root`,
		);
	}
	let mediaFetchCalled = false;
	await assert.rejects(
		publicApi.fetchRemoteMedia({
			url: "http://127.0.0.1/private.wav",
			fetchImpl: async () => {
				mediaFetchCalled = true;
				throw new Error("Blocked media URL reached fetch");
			},
		}),
		publicApi.MediaFetchError,
	);
	assert.equal(
		mediaFetchCalled,
		false,
		"packed media API rejects loopback before transport",
	);
	await assert.rejects(
		publicApi.readResponseWithLimit(new Response("12345"), 4),
		{ code: "max_bytes" },
	);
	for (const hostApi of [
		"buildProviderCachePlan",
		"normalizeSchemaForCerebras",
		"sanitizeFunctionNameForCerebras",
		"cloneSchemaForBoundedTransport",
		"MAX_CEREBRAS_SCHEMA_WALK_DEPTH",
		"MAX_CEREBRAS_SCHEMA_WALK_NODES",
		"CEREBRAS_SCHEMA_UNBOUNDED",
		"OptimizedPromptService",
		"OPTIMIZED_PROMPT_TASKS",
		"LIFEOPS_OPTIMIZED_PROMPT_TASKS",
		"parseOptimizedPromptArtifact",
		"waitForServerReady",
		"pingServer",
		"ServerHealthError",
		"CAPABILITY_ROUTER_PROTOCOL_FIXTURE",
		"CAPABILITY_ROUTER_PROTOCOL_FIXTURE_VERSION",
		"searchKeylessWeb",
		"ManagedProviderHttpClient",
		"resolveProviderConnection",
		"buildBaseTables",
		"createJsonFileTrajectoryRecorder",
		"resolveTrajectoryDir",
		"computeCallCostUsd",
		"MODEL_PRICES_USD_PER_M_TOKENS",
		"SQLiteDatabaseAdapter",
		"messageHandlerTemplate",
		"SetupStateMachine",
		"CLISetupAdapter",
		"SetupRPCService",
		"setupProgressProvider",
	]) {
		assert.equal(
			hostApi in publicApi,
			false,
			`${hostApi} must be owned outside core`,
		);
	}
	for (const subpath of [
		"catalog",
		"catalog/app-registry",
		"node",
		"browser",
		"edge",
		"testing",
		"runtime",
		"client-public",
		"config/env-vars",
		"config",
		"config/types",
		"config/boot-config",
		"config/plugin-auto-enable",
		"config/types.agent-defaults",
		"config/types.agents",
		"config/types.eliza",
		"config/types.gateway",
		"config/types.hooks",
		"config/types.messages",
		"config/types.tools",
		"awareness",
		"contracts/health",
		"contracts",
		"i18n/validation-keywords",
		"knowledge-graph",
		"lifeops-constants",
		"lifeops-normalize",
		"markdown",
		"validation-keywords",
		"media",
		"media/attachments",
		"media/fetch",
		"media/image-description-cache",
		"media/local-store",
		"media/mime",
		"media/mime-sniffer",
	]) {
		await assert.rejects(import(`@elizaos/core/${subpath}`), {
			code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
		});
	}
} finally {
	await runtime.stop();
}
console.log(
	"Packed kernel host JSON loading, parseCharacter, persisted settings precedence, explicit plugin composition, initialization, agent/entity/self-room provisioning, deterministic inference, logger and root-only exports verified",
);
