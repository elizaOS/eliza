/** Verify the real tarball in a temporary consumer with no workspace aliases. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const core = fileURLToPath(new URL("..", import.meta.url));
const repository = path.resolve(core, "../..");
const temporary = mkdtempSync(path.join(tmpdir(), "eliza-core-consumer-"));
const env = {
	...process.env,
	NODE_OPTIONS: "",
	ELIZA_STATE_DIR: path.join(temporary, "state"),
};
const run = (command, args, cwd) =>
	execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: "pipe" });
try {
	run(process.execPath, ["scripts/clean-src-artifacts.ts", "--check"], core);
	const manifest = JSON.parse(
		readFileSync(path.join(core, "package.json"), "utf8"),
	);
	assert.ok(manifest.exports["."], "The Node runtime entrypoint is required");
	for (const [subpath, target] of Object.entries(manifest.exports)) {
		const distribution =
			typeof target === "string" ? target : (target.import ?? target.default);
		if (typeof distribution === "string" && !distribution.includes("*")) {
			assert.ok(
				existsSync(path.join(core, distribution)),
				`Missing published export ${subpath}: ${distribution}`,
			);
		}
		if (typeof target === "object" && target.types) {
			assert.ok(
				existsSync(path.join(core, target.types)),
				`Missing declarations for ${subpath}`,
			);
		}
	}
	const packed = new Map();
	function pack(directory) {
		const pkg = JSON.parse(
			readFileSync(path.join(directory, "package.json"), "utf8"),
		);
		if (packed.has(pkg.name)) return;
		const filename = `${pkg.name.replaceAll(/[/@]/g, "_")}.tgz`;
		const output = path.join(temporary, filename);
		run(
			"bun",
			["pm", "pack", "--ignore-scripts", "--filename", output, "--quiet"],
			directory,
		);
		packed.set(pkg.name, output);
		for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
			if (version.startsWith("workspace:"))
				pack(path.join(repository, "packages", name.replace("@elizaos/", "")));
		}
	}
	pack(core);
	const consumer = path.join(temporary, "consumer");
	mkdirSync(consumer);
	writeFileSync(
		path.join(consumer, "package.json"),
		JSON.stringify({
			private: true,
			type: "module",
			dependencies: Object.fromEntries(packed),
			overrides: Object.fromEntries(packed),
		}),
	);
	run("bun", ["install", "--ignore-scripts"], consumer);
	// Resolve the installed production graph, including present optional packages.
	// Development dependencies are not part of the published runtime contract.
	const visited = new Set();
	const dependencyNames = new Set();
	function inspectDependencies(manifestPath) {
		const canonical = realpathSync(manifestPath);
		if (visited.has(canonical)) return;
		visited.add(canonical);
		const pkg = JSON.parse(readFileSync(canonical, "utf8"));
		dependencyNames.add(pkg.name);
		assert.ok(
			!/^@elizaos\/(?:cloud(?:-|$)|registry(?:-|$)|credentials$|vault$|testing$|prompts$|retrieval$|plugin-)/.test(
				pkg.name,
			) &&
				!/^(?:@ai-sdk\/|@anthropic-ai\/|@openrouter\/|@aws-sdk\/|@google\/(?:genai|generative-ai)|@electric-sql\/|@napi-rs\/keyring$|ai$|openai$|handlebars$|drizzle-orm$|pg$|postgres$|keytar$)/.test(
					pkg.name,
				),
			`Packed kernel pulls optional host dependency ${pkg.name}`,
		);
		const resolver = createRequire(canonical);
		for (const name of Object.keys({
			...pkg.dependencies,
			...pkg.optionalDependencies,
		})) {
			const installed = resolver.resolve
				.paths(name)
				?.map((directory) => path.join(directory, name, "package.json"))
				.find(existsSync);
			if (!installed && Object.hasOwn(pkg.optionalDependencies ?? {}, name))
				continue;
			assert.ok(
				installed,
				`Missing production dependency ${name} of ${pkg.name}`,
			);
			inspectDependencies(installed);
		}
	}
	inspectDependencies(
		path.join(consumer, "node_modules/@elizaos/core/package.json"),
	);
	console.log(
		`Packed kernel installed production closure (${visited.size} packages): ${[...dependencyNames].sort().join(", ")}`,
	);

	// The test host supplies storage; it must not enter the published kernel closure.
	run(
		"bun",
		[
			"build",
			path.join(repository, "plugins/plugin-sqlite/index.ts"),
			"--target=node",
			"--format=esm",
			"--external",
			"@elizaos/core",
			"--outfile",
			path.join(consumer, "adapter.mjs"),
		],
		repository,
	);
	writeFileSync(
		path.join(consumer, "verify.ts"),
		`
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { SQLiteDatabaseAdapter } from './adapter.mjs';
import { AgentRuntime, ModelType, createLogger, ElizaError, parseCharacter, stringToUuid, flattenRuntimeSettings, mergeDbSettings, provisionAgent } from '@elizaos/core';
const failure = new ElizaError('packed consumer failure', { code: 'PACKED_ERROR', context: { source: 'consumer' } });
const { toElizaError } = await import('@elizaos/core');
assert.equal(toElizaError(failure), failure, 'normalization preserves the canonical error and its metadata');
// Exercise the public v2 replacement for host composition against real storage.
writeFileSync('character.json', JSON.stringify({ name: 'packed-kernel', bio: 'deterministic package verification', settings: { shouldRespondModel: 'character-model' }, secrets: { characterOnly: 'fixture-character', shared: 'character-top' } }));
const character = parseCharacter(JSON.parse(readFileSync('character.json', 'utf8')));
const original = structuredClone(character);
const agentId = stringToUuid(character.name);
assert.equal(flattenRuntimeSettings(character, {}).shouldRespondModel, 'character-model');
const adapter = SQLiteDatabaseAdapter.create(":memory:", agentId);
await adapter.initialize();
await adapter.createAgents([{ id: agentId, name: character.name, settings: { shouldRespondModel: 'database-model', defaultTemperature: 0.42, secrets: { shared: 'database-setting', databaseNested: 'fixture-nested' } }, secrets: { shared: 'database-top', databaseTop: 'fixture-top' } }]);
const merged = await mergeDbSettings(character, adapter, agentId);
assert.deepEqual(character, original, 'persisted settings merge must not mutate character input');
assert.equal(merged.settings.shouldRespondModel, 'character-model');
assert.equal(merged.settings.defaultTemperature, 0.42);
assert.deepEqual(merged.secrets, { shared: 'character-top', databaseTop: 'fixture-top', databaseNested: 'fixture-nested', characterOnly: 'fixture-character' });
let calls = 0;
const fixturePlugin = { name: 'fixture', description: 'explicit host-selected model', models: { [ModelType.TEXT_SMALL]: async (_runtime, input) => {
  assert.equal(input.prompt, 'Return the fixture value.');
  calls++;
  return 'fixture:perfect';
} } };
const runtime = new AgentRuntime({ agentId, adapter, character: merged, plugins: [fixturePlugin], logLevel: 'fatal' });
try {
  await runtime.initialize({ skipMigrations: true });
  await provisionAgent(runtime, { runMigrations: false });
  assert.equal(runtime.agentId, agentId);
  assert.equal(runtime.getSetting('defaultTemperature'), 0.42);
  assert.equal((await adapter.getEntitiesByIds([agentId]))[0].id, agentId);
  assert.equal((await adapter.getRoomsByIds([agentId]))[0].id, agentId);
  assert.ok((await adapter.getParticipantsForRooms([agentId]))[0].entityIds.includes(agentId));
  assert.equal(runtime.messageService, null);
  assert.equal("routes" in runtime, false);
  assert.equal(Symbol.for('elizaos.http-runtime') in runtime, false, 'HTTP state is installed explicitly');

  assert.equal("rerankMemories" in runtime, false);
  assert.equal("companionUrl" in runtime, false);
  assert.equal(runtime.actions.length, 0);
  assert.equal(runtime.providers.length, 0);
  assert.equal(await runtime.useModel(ModelType.TEXT_SMALL, { prompt: 'Return the fixture value.' }), 'fixture:perfect');
  assert.equal(calls, 1);
  assert.equal(typeof createLogger().info, 'function');
  const publicApi = await import('@elizaos/core');
  const host = {};
  publicApi.registerHttpPluginRoutes(host, { name: 'fixture', description: 'HTTP fixture', routes: [{ type: 'GET', path: '/health' }] });
  assert.equal(publicApi.getPluginHttpRoutes(host, 'fixture')[0].path, '/fixture/health');
  assert.throws(() => publicApi.registerHttpPluginRoutes(host, { name: 'unsafe', description: 'Invalid public write', routes: [{ type: 'POST', path: '/write', public: true, publicReason: 'fixture' }] }), /publicWrite/);
  assert.equal(publicApi.getHttpRuntime(host).routes.length, 1, 'rejected routes do not alter host state');
  const boundaryRecord = new (class BoundaryRecord { value = 1; })();
  assert.equal(publicApi.asObjectRecord(boundaryRecord), boundaryRecord);
  assert.equal(publicApi.asRecord(boundaryRecord), null);
  const exportPrompt = 'complete model request 🟠 '.repeat(12000) + 'FINAL-REQUEST';
  const exportResponse = 'complete response with final reference';
  const exportRecord = {
    trajectoryId: 'packed-trajectory', agentId, startTime: 1, metadata: { source: 'packed-consumer' },
    steps: [{ stepId: 'packed-step', timestamp: 1, llmCalls: [{
      callId: 'packed-call', model: 'fixture', systemPrompt: 'Preserve the request.',
      userPrompt: exportPrompt, response: exportResponse,
    }] }],
  };
  for (const format of ['json', 'jsonl']) {
    const exported = publicApi.serializeTrajectoryExport([exportRecord], { format });
    const parsed = JSON.parse(exported.data);
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    assert.equal(row.request.prompt, exportPrompt);
    assert.equal(row.response.text, exportResponse);
  }
  assert.throws(() => publicApi.serializeTrajectoryExport([
    { ...exportRecord, steps: undefined, stepsJson: '{invalid' },
  ], { format: 'jsonl' }), publicApi.ElizaError);
  const keywordMemory = { id: 'keyword', content: { text: 'automobile receipt' } };
  const semanticMemory = { id: 'semantic', content: { text: 'bought a car' } };
  const attachmentMemory = { id: 'attachment', content: {} };
  assert.deepEqual(publicApi.rerankMemories('automobile', [semanticMemory, attachmentMemory, keywordMemory]), [keywordMemory, semanticMemory, attachmentMemory]);
  assert.equal(new publicApi.BM25([{ title: 'receipt', content: 'automobile receipt' }]).search('automobile', 1)[0].index, 0);

  publicApi.registerCuratedApp({
    slug: 'packed-core-fixture',
    canonicalName: '@elizaos/plugin-packed-core-fixture',
    aliases: ['packed fixture'],
  });
  assert.equal(publicApi.getElizaCuratedAppDefinition('packed fixture')?.canonicalName, '@elizaos/plugin-packed-core-fixture');
  assert.ok(publicApi.getCuratedAppDefinitions().some((entry) => entry.slug === 'packed-core-fixture'));
  const catalogApi = await import('@elizaos/core/catalog');
  assert.equal(catalogApi.registerCuratedApp, publicApi.registerCuratedApp);
  assert.equal(catalogApi.getRegisteredCuratedApps, publicApi.getRegisteredCuratedApps);
  const registry = publicApi.loadRegistry();
  assert.ok(publicApi.getApps(registry).length > 0, 'packed root reads the shipped first-party catalog');

  const walletFields = Object.freeze({ ALCHEMY_API_KEY: '  fixture-alchemy  ', INFURA_API_KEY: 'fixture-retired' });
  const walletProviders = Object.freeze({ evm: 'ALCHEMY', bsc: 'eliza-cloud', solana: 'eliza-cloud' });
  assert.deepEqual(publicApi.buildWalletRpcUpdateRequest({
    rpcFieldValues: walletFields,
    selectedProviders: walletProviders,
    selectedNetwork: 'testnet',
  }), {
    selections: { evm: 'alchemy', bsc: 'eliza-cloud', solana: 'eliza-cloud' },
    walletNetwork: 'testnet',
    credentials: { ALCHEMY_API_KEY: 'fixture-alchemy', INFURA_API_KEY: '' },
  });
  assert.equal(walletFields.ALCHEMY_API_KEY, '  fixture-alchemy  ', 'request construction preserves its input');

  for (const retired of ['loadCharacters', 'createRuntimes', 'mergeSettingsInto']) {
    assert.equal(retired in publicApi, false, retired + ' is retired from the v2 public API');
  }
  for (const mediaApi of ['fetchRemoteMedia', 'detectMime', 'describeImageCached', 'resolveAttachmentBytes']) {
    assert.equal(typeof publicApi[mediaApi], 'function', mediaApi + ' is available from the public root');
  }
  let mediaFetchCalled = false;
  await assert.rejects(publicApi.fetchRemoteMedia({
    url: 'http://127.0.0.1/private.wav',
    fetchImpl: async () => { mediaFetchCalled = true; throw new Error('Blocked media URL reached fetch'); },
  }), publicApi.MediaFetchError);
  assert.equal(mediaFetchCalled, false, 'packed media API rejects loopback before transport');
  await assert.rejects(publicApi.readResponseWithLimit(new Response('12345'), 4), { code: 'max_bytes' });
  for (const hostApi of ['buildProviderCachePlan', 'normalizeSchemaForCerebras', 'sanitizeFunctionNameForCerebras', 'cloneSchemaForBoundedTransport', 'MAX_CEREBRAS_SCHEMA_WALK_DEPTH', 'MAX_CEREBRAS_SCHEMA_WALK_NODES', 'CEREBRAS_SCHEMA_UNBOUNDED', 'OptimizedPromptService', 'OPTIMIZED_PROMPT_TASKS', 'LIFEOPS_OPTIMIZED_PROMPT_TASKS', 'parseOptimizedPromptArtifact', 'waitForServerReady', 'pingServer', 'ServerHealthError', 'CAPABILITY_ROUTER_PROTOCOL_FIXTURE', 'CAPABILITY_ROUTER_PROTOCOL_FIXTURE_VERSION', 'searchKeylessWeb', 'ManagedProviderHttpClient', 'resolveProviderConnection', 'buildBaseTables', 'createJsonFileTrajectoryRecorder', 'resolveTrajectoryDir', 'computeCallCostUsd', 'MODEL_PRICES_USD_PER_M_TOKENS', 'SQLiteDatabaseAdapter', 'trajectoryToPlaintext', 'messageHandlerTemplate', 'SetupStateMachine', 'CLISetupAdapter', 'SetupRPCService', 'setupProgressProvider']) {
    assert.equal(hostApi in publicApi, false, hostApi + ' must be owned outside core');
  }
  for (const subpath of ['catalog/app-registry', 'node', 'browser', 'edge', 'testing', 'runtime', 'client-public', 'config/env-vars', 'config', 'config/types', 'config/boot-config', 'config/plugin-auto-enable', 'config/types.agent-defaults', 'config/types.agents', 'config/types.eliza', 'config/types.gateway', 'config/types.hooks', 'config/types.messages', 'config/types.tools', 'awareness', 'contracts/health', 'contracts', 'i18n/validation-keywords', 'knowledge-graph', 'lifeops-constants', 'lifeops-normalize', 'markdown', 'validation-keywords', 'media', 'media/attachments', 'media/fetch', 'media/image-description-cache', 'media/local-store', 'media/mime', 'media/mime-sniffer']) {
    await assert.rejects(import('@elizaos/core/' + subpath), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  }
} finally { await runtime.stop(); }
console.log('Packed kernel host JSON loading, parseCharacter, persisted settings precedence, explicit plugin composition, initialization, agent/entity/self-room provisioning, deterministic inference, logger and root-only exports verified');
`,
	);
	writeFileSync(
		path.join(consumer, "consumer.ts"),
		`
import { AgentRuntime, ModelType, type IAgentRuntime, type Plugin, type UUID, type Entity, type KnowledgeGraphEntity, type MessageExample, type FirstRunMessageExample, type AppMemoryConfig, type MemoryConfig } from '@elizaos/core';
const graphName: KnowledgeGraphEntity['preferredName'] = 'fixture';
const firstRunSender: FirstRunMessageExample['user'] = 'fixture';
// @ts-expect-error Runtime entities retain their separate account shape.
type InvalidRuntimeGraphName = Entity['preferredName'];
// @ts-expect-error Runtime message examples use name, not the first-run user field.
type InvalidRuntimeExampleUser = MessageExample['user'];
const appMemoryBackend: AppMemoryConfig['backend'] = 'builtin';
// @ts-expect-error Runtime memory settings retain their separate shape.
type InvalidRuntimeMemoryBackend = MemoryConfig['backend'];
void appMemoryBackend;
void graphName;
void firstRunSender;
import type { CatalogModel, RuntimeClass } from '@elizaos/core/contracts/local-inference';
const runtimeClass: RuntimeClass = 'fused-eliza1';
const catalogRuntimeClass: CatalogModel['runtimeClass'] = runtimeClass;
// @ts-expect-error The wire discriminator must remain typed without a native plugin installation.
const invalidRuntimeClass: CatalogModel['runtimeClass'] = 'missing-runtime';
void catalogRuntimeClass;
void invalidRuntimeClass;
import type { Route, AgentStreamEventType, StreamEventType, AgentLogEntry, LogEntry } from '@elizaos/core';
const hostEvent: AgentStreamEventType = 'agent_event';
// @ts-expect-error Runtime stream events retain their own discriminator.
const runtimeEvent: StreamEventType = hostEvent;
void runtimeEvent;
const hostRoute: Route = { type: 'GET', path: '/health' };
void hostRoute;
const hostLog: AgentLogEntry['source'] = 'host';
void hostLog;
void (null as unknown as LogEntry);
// @ts-expect-error Host composition facade types are retired in v2.
import type { CreateRuntimesOptions } from '@elizaos/core';
// @ts-expect-error Host composition facade types are retired in v2.
import type { LoadCharactersOptions } from '@elizaos/core';
// @ts-expect-error Host composition facade types are retired in v2.
import type { AgentRecordForMerge } from '@elizaos/core';
const plugin: Plugin = { name: 'consumer', description: 'typed consumer', models: { [ModelType.TEXT_SMALL]: async (_runtime, _params) => 'fixture' } };
const runtime: IAgentRuntime = new AgentRuntime({ character: { name: 'consumer', bio: [] }, plugins: [plugin] });
const id: UUID = runtime.agentId;
void id;
const text: Promise<string> = runtime.useModel(ModelType.TEXT_SMALL, { prompt: 'fixture' });
void text;
`,
	);
	run(
		process.execPath,
		[
			path.join(repository, "node_modules/typescript/bin/tsc"),
			// The consumer supplies every compiler option and may live below a
			// repository-local TMPDIR; never inherit an ancestor tsconfig.
			"--ignoreConfig",
			"--noEmit",
			"--strict",
			"--skipLibCheck",
			"--module",
			"NodeNext",
			"--target",
			"ES2024",
			"--types",
			"node",
			"--typeRoots",
			path.join(repository, "node_modules/@types"),
			"consumer.ts",
		],
		consumer,
	);
	process.stdout.write(run(process.execPath, ["verify.ts"], consumer));
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
