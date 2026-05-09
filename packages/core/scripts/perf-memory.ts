import { v4 as uuidv4 } from "uuid";
import {
	AUTONOMY_TASK_NAME,
	AutonomyService,
} from "../src/features/autonomy/service.ts";
import { AgentRuntime } from "../src/runtime.ts";
import {
	ChannelType,
	type Character,
	type Entity,
	type Memory,
	ModelType,
	type Room,
	type UUID,
	type World,
} from "../src/types/index.ts";
import { stringToUuid } from "../src/utils.ts";

type ScenarioSample = {
	batch: number;
	elapsedMs: number;
	iterationsCompleted: number;
	heapUsedMb: number;
	rssMb: number;
	externalMb: number;
	arrayBuffersMb: number;
	stateCacheSize: number;
	dynamicPromptMetricsSize: number;
	autonomyMessageCount?: number;
	autonomyMemoryCount?: number;
};

type ScenarioSummary = {
	totalIterations: number;
	totalElapsedMs: number;
	heapUsedStartMb: number;
	heapUsedEndMb: number;
	heapUsedPostWarmupSpreadMb: number;
	rssStartMb: number;
	rssEndMb: number;
	rssPostWarmupSpreadMb: number;
	finalStateCacheSize: number;
	finalDynamicPromptMetricsSize: number;
	finalAutonomyMessageCount?: number;
	finalAutonomyMemoryCount?: number;
};

type ScenarioResult = {
	name: string;
	samples: ScenarioSample[];
	summary: ScenarioSummary;
};

type RuntimeProfileOptions = {
	persistMessages: boolean;
	enableAutonomy?: boolean;
};

const MESSAGE_ITERATIONS = parsePositiveInt(
	process.env.MESSAGE_ITERATIONS,
	1200,
);
const ROOM_CHURN_ITERATIONS = parsePositiveInt(
	process.env.ROOM_CHURN_ITERATIONS,
	1200,
);
const AUTONOMY_ITERATIONS = parsePositiveInt(
	process.env.AUTONOMY_ITERATIONS,
	120,
);
const BATCH_SIZE = parsePositiveInt(process.env.BATCH_SIZE, 200);

function parsePositiveInt(
	rawValue: string | undefined,
	defaultValue: number,
): number {
	if (!rawValue) {
		return defaultValue;
	}

	const parsed = Number.parseInt(rawValue, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return defaultValue;
	}

	return parsed;
}

function formatMb(value: number): number {
	return Number(value.toFixed(2));
}

function forceGc(): void {
	const gcFn =
		(globalThis as { gc?: (major?: boolean) => void }).gc ??
		(globalThis as { Bun?: { gc?: (major?: boolean) => void } }).Bun?.gc;

	if (typeof gcFn === "function") {
		gcFn(true);
	}
}

function buildProfileCharacter(overrides: Partial<Character> = {}): Character {
	return {
		id: uuidv4() as UUID,
		name: "Memory Profile Agent",
		bio: ["Profiled benchmark agent"],
		system: "You are a deterministic benchmark agent.",
		templates: {},
		messageExamples: [],
		postExamples: [],
		topics: ["profiling"],
		adjectives: ["deterministic"],
		knowledge: [],
		plugins: [],
		secrets: {},
		settings: {
			ACTION_PLANNING: false,
			CHECK_SHOULD_RESPOND: true,
			USE_MULTI_STEP: false,
			MAX_MULTISTEP_ITERATIONS: 1,
			...overrides.settings,
		},
		style: { all: [], chat: [], post: [] },
		...overrides,
	};
}

function buildWorld(worldId: UUID, agentId: UUID): World {
	return {
		id: worldId,
		name: "Profile World",
		agentId,
		serverId: worldId,
		messageServerId: worldId,
		metadata: {},
	} as World;
}

function buildRoom(roomId: UUID, worldId: UUID): Room {
	return {
		id: roomId,
		name: `Profile Room ${String(roomId).slice(0, 8)}`,
		worldId,
		source: "memory-profile",
		type: ChannelType.GROUP,
		channelId: String(roomId),
		serverId: worldId,
		metadata: {},
	} as Room;
}

function buildEntity(entityId: UUID, agentId: UUID, label: string): Entity {
	return {
		id: entityId,
		agentId,
		names: [label],
		metadata: {},
	} as Entity;
}

function silenceRuntimeLogger(runtime: AgentRuntime): void {
	runtime.logger.trace = () => undefined;
	runtime.logger.debug = () => undefined;
	runtime.logger.info = () => undefined;
	runtime.logger.warn = () => undefined;
	runtime.logger.error = () => undefined;
	runtime.logger.success = () => undefined;
	runtime.logger.fatal = () => undefined;
}

function registerBenchmarkModels(runtime: AgentRuntime): void {
	runtime.registerModel(
		ModelType.TEXT_SMALL,
		async () =>
			"name: Memory Profile Agent\nreasoning: benchmark\naction: RESPOND",
		"memory-profile",
		100,
	);

	runtime.registerModel(
		ModelType.TEXT_LARGE,
		async () =>
			"thought: benchmark-thought\nactions: REPLY\ntext: benchmark-response\nsimple: true",
		"memory-profile",
		100,
	);

	runtime.registerModel(
		ModelType.TEXT_EMBEDDING,
		async () => [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08],
		"memory-profile",
		100,
	);
}

function installSyntheticContext(
	runtime: AgentRuntime,
	options: RuntimeProfileOptions,
): void {
	const worldId = stringToUuid(`memory-profile-world-${runtime.agentId}`);
	const userEntityId = stringToUuid(`memory-profile-user-${runtime.agentId}`);
	const autonomyEntityId = stringToUuid("00000000-0000-0000-0000-000000000002");
	const agentEntity = buildEntity(
		runtime.agentId,
		runtime.agentId,
		runtime.character.name ?? "Agent",
	);
	const userEntity = buildEntity(userEntityId, runtime.agentId, "Profile User");
	const autonomyEntity = buildEntity(
		autonomyEntityId,
		runtime.agentId,
		"Autonomy Prompt",
	);

	runtime.getWorld = async (id: UUID): Promise<World | null> =>
		buildWorld(id || worldId, runtime.agentId);

	runtime.getRoom = async (roomId: UUID): Promise<Room | null> =>
		buildRoom(roomId, worldId);

	runtime.getRoomsByIds = async (roomIds: UUID[]): Promise<Room[]> =>
		roomIds.map((roomId) => buildRoom(roomId, worldId));

	runtime.getEntityById = async (entityId: UUID): Promise<Entity | null> =>
		entityId === runtime.agentId
			? agentEntity
			: buildEntity(entityId, runtime.agentId, "Profile User");

	runtime.getEntitiesByIds = async (entityIds: UUID[]): Promise<Entity[]> =>
		entityIds.map((entityId) =>
			entityId === runtime.agentId
				? agentEntity
				: entityId === autonomyEntityId
					? autonomyEntity
					: buildEntity(entityId, runtime.agentId, "Profile User"),
		);

	runtime.getEntitiesForRoom = async (): Promise<Entity[]> => [
		agentEntity,
		userEntity,
		autonomyEntity,
	];

	runtime.getParticipantsForRoom = async (): Promise<UUID[]> => [
		runtime.agentId,
		userEntityId,
	];

	runtime.getRoomsForParticipants = async (): Promise<Room[]> => [];
	runtime.getParticipantUserState = async (): Promise<"FOLLOWED"> => "FOLLOWED";

	runtime.log = async () => undefined;
	runtime.queueEmbeddingGeneration = async () => undefined;

	const runtimeInternal = runtime as {
		adapter?: {
			log?: (...args: unknown[]) => Promise<void>;
		};
	};

	if (runtimeInternal.adapter?.log) {
		runtimeInternal.adapter.log = async () => undefined;
	}

	if (!options.persistMessages) {
		runtime.getMemoryById = async (): Promise<Memory | null> => null;
		runtime.getMemories = async (): Promise<Memory[]> => [];
		runtime.getMemoriesByRoomIds = async (): Promise<Memory[]> => [];
		runtime.createMemory = async (memory: Memory): Promise<UUID> =>
			(memory.id ?? (uuidv4() as UUID)) as UUID;
		runtime.updateMemory = async (): Promise<boolean> => true;
		runtime.deleteMemory = async (): Promise<void> => undefined;
		runtime.deleteManyMemories = async (): Promise<void> => undefined;
	}
}

async function createProfileRuntime(
	options: RuntimeProfileOptions,
): Promise<AgentRuntime> {
	const runtime = new AgentRuntime({
		character: buildProfileCharacter(),
		actionPlanning: false,
		checkShouldRespond: true,
		enableAutonomy: options.enableAutonomy ?? false,
		logLevel: "fatal",
	});

	silenceRuntimeLogger(runtime);
	registerBenchmarkModels(runtime);
	await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
	installSyntheticContext(runtime, options);
	return runtime;
}

function getDynamicPromptMetricsSize(): number {
	const runtimeClass = AgentRuntime as {
		dynamicPromptMetrics?: Map<string, unknown>;
	};
	return runtimeClass.dynamicPromptMetrics?.size ?? 0;
}

function captureSample(
	runtime: AgentRuntime,
	batch: number,
	elapsedMs: number,
	iterationsCompleted: number,
	extra: Partial<ScenarioSample> = {},
): ScenarioSample {
	forceGc();
	const usage = process.memoryUsage();

	return {
		batch,
		elapsedMs: formatMb(elapsedMs),
		iterationsCompleted,
		heapUsedMb: formatMb(usage.heapUsed / 1024 / 1024),
		rssMb: formatMb(usage.rss / 1024 / 1024),
		externalMb: formatMb(usage.external / 1024 / 1024),
		arrayBuffersMb: formatMb(usage.arrayBuffers / 1024 / 1024),
		stateCacheSize: runtime.stateCache.size,
		dynamicPromptMetricsSize: getDynamicPromptMetricsSize(),
		...extra,
	};
}

function summarizeSamples(
	samples: ScenarioSample[],
	totalIterations: number,
): ScenarioSummary {
	const steadySamples = samples.length > 1 ? samples.slice(1) : samples;
	const heapValues = steadySamples.map((sample) => sample.heapUsedMb);
	const rssValues = steadySamples.map((sample) => sample.rssMb);
	const first = samples[0];
	const last = samples[samples.length - 1];

	return {
		totalIterations,
		totalElapsedMs: formatMb(last?.elapsedMs ?? 0),
		heapUsedStartMb: first?.heapUsedMb ?? 0,
		heapUsedEndMb: last?.heapUsedMb ?? 0,
		heapUsedPostWarmupSpreadMb: formatMb(
			Math.max(...heapValues) - Math.min(...heapValues),
		),
		rssStartMb: first?.rssMb ?? 0,
		rssEndMb: last?.rssMb ?? 0,
		rssPostWarmupSpreadMb: formatMb(
			Math.max(...rssValues) - Math.min(...rssValues),
		),
		finalStateCacheSize: last?.stateCacheSize ?? 0,
		finalDynamicPromptMetricsSize: last?.dynamicPromptMetricsSize ?? 0,
		finalAutonomyMessageCount: last?.autonomyMessageCount,
		finalAutonomyMemoryCount: last?.autonomyMemoryCount,
	};
}

async function runMessageScenario(params: {
	name: string;
	iterations: number;
	uniqueRoomPerMessage: boolean;
	autonomous: boolean;
}): Promise<ScenarioResult> {
	const runtime = await createProfileRuntime({ persistMessages: false });
	const callback = async (): Promise<Memory[]> => [];
	const baseRoomId = stringToUuid(`memory-profile-room-${params.name}`);
	const entityId = stringToUuid(`memory-profile-user-${params.name}`);
	const startedAt = performance.now();
	const samples: ScenarioSample[] = [];

	try {
		for (
			let batchIndex = 0, iteration = 0;
			iteration < params.iterations;
			batchIndex += 1
		) {
			const batchIterations = Math.min(
				BATCH_SIZE,
				params.iterations - iteration,
			);

			for (let offset = 0; offset < batchIterations; offset += 1) {
				const currentIteration = iteration + offset;
				const roomId = params.uniqueRoomPerMessage
					? stringToUuid(
							`memory-profile-room-${params.name}-${currentIteration}`,
						)
					: baseRoomId;

				const message: Memory = {
					id: uuidv4() as UUID,
					entityId,
					agentId: runtime.agentId,
					roomId,
					createdAt: Date.now(),
					content: {
						text: `Profile message ${currentIteration}`,
						source: "memory-profile",
						channelType: ChannelType.GROUP,
						metadata: params.autonomous
							? {
									isAutonomous: true,
									autonomyMode: "continuous",
								}
							: undefined,
					},
				};

				await runtime.messageService?.handleMessage(runtime, message, callback);
			}

			iteration += batchIterations;
			samples.push(
				captureSample(
					runtime,
					batchIndex + 1,
					performance.now() - startedAt,
					iteration,
				),
			);
		}
	} finally {
		await runtime.stop();
	}

	return {
		name: params.name,
		samples,
		summary: summarizeSamples(samples, params.iterations),
	};
}

async function runAutonomyScenario(
	iterations: number,
): Promise<ScenarioResult> {
	const runtime = await createProfileRuntime({
		persistMessages: true,
		enableAutonomy: false,
	});
	await AutonomyService.start(runtime);
	const autonomyRoomId = stringToUuid(`autonomy-room-${runtime.agentId}`);
	const autonomyWorker = runtime.getTaskWorker(AUTONOMY_TASK_NAME);
	const startedAt = performance.now();
	const samples: ScenarioSample[] = [];

	if (!autonomyWorker) {
		throw new Error("Autonomy task worker was not registered");
	}

	try {
		for (
			let batchIndex = 0, completed = 0;
			completed < iterations;
			batchIndex += 1
		) {
			const batchIterations = Math.min(BATCH_SIZE, iterations - completed);

			for (let offset = 0; offset < batchIterations; offset += 1) {
				await autonomyWorker.execute(runtime, {}, {
					id: uuidv4() as UUID,
					name: AUTONOMY_TASK_NAME,
				} as Parameters<typeof autonomyWorker.execute>[2]);
			}

			completed += batchIterations;

			const messageCount = (
				await runtime.getMemories({
					roomId: autonomyRoomId,
					tableName: "messages",
					count: 500,
				})
			).length;
			const memoryCount = (
				await runtime.getMemories({
					roomId: autonomyRoomId,
					tableName: "memories",
					count: 500,
				})
			).length;

			samples.push(
				captureSample(
					runtime,
					batchIndex + 1,
					performance.now() - startedAt,
					completed,
					{
						autonomyMessageCount: messageCount,
						autonomyMemoryCount: memoryCount,
					},
				),
			);
		}
	} finally {
		await runtime.stop();
	}

	return {
		name: "autonomy_service",
		samples,
		summary: summarizeSamples(samples, iterations),
	};
}

async function main(): Promise<void> {
	const results: ScenarioResult[] = [];

	results.push(
		await runMessageScenario({
			name: "message_same_room",
			iterations: MESSAGE_ITERATIONS,
			uniqueRoomPerMessage: false,
			autonomous: false,
		}),
	);

	results.push(
		await runMessageScenario({
			name: "message_room_churn",
			iterations: ROOM_CHURN_ITERATIONS,
			uniqueRoomPerMessage: true,
			autonomous: false,
		}),
	);

	results.push(
		await runMessageScenario({
			name: "message_autonomous_flag",
			iterations: MESSAGE_ITERATIONS,
			uniqueRoomPerMessage: false,
			autonomous: true,
		}),
	);

	results.push(await runAutonomyScenario(AUTONOMY_ITERATIONS));

	forceGc();

	const payload = {
		config: {
			batchSize: BATCH_SIZE,
			messageIterations: MESSAGE_ITERATIONS,
			roomChurnIterations: ROOM_CHURN_ITERATIONS,
			autonomyIterations: AUTONOMY_ITERATIONS,
			runtime: process.release.name,
			version: process.version,
		},
		results,
	};

	// eslint-disable-next-line no-console
	console.log(JSON.stringify(payload, null, 2));
}

await main();
