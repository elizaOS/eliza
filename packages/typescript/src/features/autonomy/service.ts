/**
 * Autonomy Service for elizaOS
 *
 * Provides autonomous operation for agents using the prompt batcher (Option A).
 * One register only: the batcher. When enableAutonomy is true, a recurring
 * section is registered; the batcher's background tick and minCycleMs drive
 * when the autonomy section drains. No Task DB or worker.
 */

// Review: Templates were relocated, and dependency on @elizaos/prompts is now obsolete in this module.
import { v4 as uuidv4 } from "uuid";
import {
	autonomyContinuousContinueTemplate,
	autonomyContinuousFirstTemplate,
	autonomyTaskContinueTemplate,
	autonomyTaskFirstTemplate,
} from "../../prompts";
import {
	ChannelType,
	type Content,
	type ContentValue,
	type Entity,
	EventType,
	type IAgentRuntime,
	type Memory,
	type UUID,
} from "../../types";
import { Service } from "../../types/service";
import { stringToUuid } from "../../utils";
import { runAutonomyPostResponse } from "./execution-facade";
import type { AutonomyStatus } from "./types";

/**
 * Service type constant for autonomy
 */
export const AUTONOMY_SERVICE_TYPE = "AUTONOMY" as const;

/**
 * Task name for autonomy thinking
 */
export const AUTONOMY_TASK_NAME = "AUTONOMY_THINK" as const;

/**
 * Tags used for autonomy tasks
 */
export const AUTONOMY_TASK_TAGS = ["repeat", "autonomy", "internal"] as const;
const AUTONOMY_MESSAGE_SERVER_ID = stringToUuid("autonomy-message-server");

/**
 * AutonomyService - Manages autonomous agent operation.
 *
 * Uses the prompt batcher only (Option A): one register, no Task.
 * When enableAutonomy is true, a recurring section is registered;
 * the batcher's background tick and minCycleMs drive when it drains.
 */
export class AutonomyService extends Service {
	static serviceType = AUTONOMY_SERVICE_TYPE;
	static serviceName = "Autonomy";

	protected isRunning = false;
	protected intervalMs: number;
	protected autonomousRoomId: UUID;
	protected autonomousWorldId: UUID;
	private isThinking = false;
	protected autonomyEntityId: UUID; // Dedicated entity ID for autonomy prompts (not the agent's ID)

	private getAutonomyMode(): "continuous" | "task" {
		const raw = this.runtime.getSetting("AUTONOMY_MODE");
		if (raw === "task") return "task";
		return "continuous";
	}

	private getTargetRoomId(): UUID | null {
		const raw = this.runtime.getSetting("AUTONOMY_TARGET_ROOM_ID");
		if (typeof raw !== "string" || raw.trim().length === 0) return null;
		try {
			return stringToUuid(raw.trim());
		} catch {
			return null;
		}
	}

	private async getTargetRoomContextText(): Promise<string> {
		const targetRoomId = this.getTargetRoomId();
		const participantRooms = await this.runtime.getRoomsForParticipant(
			this.runtime.agentId,
		);
		const orderedRoomIds: UUID[] = [];
		if (targetRoomId) {
			orderedRoomIds.push(targetRoomId);
		}
		for (const roomId of participantRooms) {
			if (!orderedRoomIds.includes(roomId)) {
				orderedRoomIds.push(roomId);
			}
		}
		if (orderedRoomIds.length === 0) {
			return "(no rooms configured)";
		}

		const rooms = await this.runtime.getRoomsByIds(orderedRoomIds);
		if (!rooms) {
			return "(no rooms found)";
		}

		const roomNameById = new Map<UUID, string>();
		for (const room of rooms) {
			roomNameById.set(room.id, room.name ?? String(room.id));
		}

		const messageRoomIds = orderedRoomIds.filter(
			(roomId) => roomId !== this.autonomousRoomId,
		);
		const perRoomLimit = 10;
		const [messages, autonomyMemories] = await Promise.all([
			messageRoomIds.length > 0
				? this.runtime.getMemoriesByRoomIds({
						tableName: "messages",
						roomIds: messageRoomIds,
						limit: perRoomLimit * messageRoomIds.length,
					})
				: Promise.resolve([]),
			this.runtime.getMemories({
				roomId: this.autonomousRoomId,
				limit: perRoomLimit,
				tableName: "memories",
			}),
		]);

		const entityIds = new Set<UUID>();
		for (const memory of messages) {
			if (memory.entityId === this.runtime.agentId) {
				continue;
			}
			entityIds.add(memory.entityId);
		}
		const entityNames = await this.buildEntityNameLookup(entityIds);

		const messagesByRoom = new Map<UUID, Memory[]>();
		const sortedMessages = [...messages].sort(
			(a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
		);
		for (const memory of sortedMessages) {
			if (memory.entityId === this.runtime.agentId) {
				continue;
			}
			const bucket = messagesByRoom.get(memory.roomId) ?? [];
			if (bucket.length >= perRoomLimit) {
				continue;
			}
			bucket.push(memory);
			messagesByRoom.set(memory.roomId, bucket);
		}

		const roomSections = messageRoomIds.map((roomId) => {
			const roomName = roomNameById.get(roomId) ?? String(roomId);
			const roomMessages = messagesByRoom.get(roomId) ?? [];
			if (roomMessages.length === 0) {
				return `Room: ${roomName}\n(no recent messages)`;
			}
			const lines = roomMessages
				.slice()
				.reverse()
				.map((memory) => {
					const author =
						entityNames.get(memory.entityId) ?? String(memory.entityId);
					const text =
						typeof memory.content.text === "string" ? memory.content.text : "";
					return `${author}: ${text}`;
				})
				.filter((line) => line.trim().length > 0);
			return `Room: ${roomName}\n${lines.join("\n")}`;
		});

		const autonomyThoughts = autonomyMemories
			.filter((memory) => memory.entityId === this.runtime.agentId)
			.map((memory) =>
				typeof memory.content.text === "string" ? memory.content.text : "",
			)
			.filter((text) => text.trim().length > 0);
		const autonomySection =
			autonomyThoughts.length > 0
				? ["Autonomous thoughts:", ...autonomyThoughts].join("\n")
				: "Autonomous thoughts: (none)";

		return [...roomSections, autonomySection].join("\n\n");
	}

	constructor() {
		super();
		// Default interval of 30 seconds
		this.intervalMs = 30000;
		// Generate unique room ID for autonomous thoughts
		this.autonomousRoomId = stringToUuid(uuidv4());
		this.autonomousWorldId = stringToUuid(
			"00000000-0000-0000-0000-000000000001",
		);
		// Generate a dedicated entity ID for autonomy prompts
		// This is different from the agent's ID to avoid "skipping message from self"
		this.autonomyEntityId = stringToUuid(
			"00000000-0000-0000-0000-000000000002",
		);
	}

	/**
	 * Start the autonomy service
	 */
	static async start(runtime: IAgentRuntime): Promise<AutonomyService> {
		const service = new AutonomyService();
		service.runtime = runtime;
		await service.initialize();
		return service;
	}

	/**
	 * Initialize the service. Option A: autonomy is driven only by the prompt batcher; no Task.
	 * WHY: We only register the batcher section when enableAutonomy is true; no task worker or createTask.
	 */
	private async initialize(): Promise<void> {
		this.runtime.logger.info(
			{ src: "autonomy", agentId: this.runtime.agentId },
			`Using autonomous room ID: ${this.autonomousRoomId}`,
		);

		const autonomyEnabled = this.runtime.enableAutonomy;

		this.runtime.logger.debug(
			{ src: "autonomy", agentId: this.runtime.agentId },
			`Runtime enableAutonomy value: ${autonomyEnabled}`,
		);

		await this.ensureAutonomousContext();

		// WHY: After migration to batcher-only, old DB rows for AUTONOMY_THINK are never run (no worker); remove them to avoid clutter and confusion.
		try {
			const existingTasks = await this.runtime.getTasks({
				tags: [...AUTONOMY_TASK_TAGS],
				agentIds: [this.runtime.agentId],
			});
			for (const task of existingTasks) {
				if (task.id && task.name === AUTONOMY_TASK_NAME) {
					await this.runtime.deleteTask(task.id);
					this.runtime.logger.debug(
						{ src: "autonomy", agentId: this.runtime.agentId, taskId: task.id },
						"Removed orphaned autonomy task",
					);
				}
			}
		} catch (err) {
			this.runtime.logger.warn(
				{ src: "autonomy", agentId: this.runtime.agentId, error: err },
				"Could not clean orphaned autonomy tasks",
			);
		}

		if (autonomyEnabled) {
			this.runtime.logger.info(
				{ src: "autonomy", agentId: this.runtime.agentId },
				"Autonomy enabled (enableAutonomy: true), registering with prompt batcher.",
			);
			this.registerAutonomyBatcherSection();
			this.isRunning = true;
		} else {
			this.runtime.logger.info(
				{ src: "autonomy", agentId: this.runtime.agentId },
				"Autonomy not enabled. Set enableAutonomy: true in runtime options or call enableAutonomy() to start.",
			);
		}
	}

	/**
	 * Ensure autonomous world and room exist
	 */
	private async ensureAutonomyEntity(): Promise<void> {
		const runtimeWithUpsert = this.runtime as IAgentRuntime & {
			upsertEntities?: (entities: Entity[]) => Promise<void>;
		};
		const autonomyEntity: Entity = {
			id: this.autonomyEntityId,
			names: ["Autonomy"],
			agentId: this.runtime.agentId,
			metadata: {
				type: "autonomy",
				description: "Dedicated entity for autonomy service prompts",
			},
		};
		const existingEntity = this.runtime.getEntityById
			? await this.runtime.getEntityById(this.autonomyEntityId)
			: null;

		if (!existingEntity) {
			const created = await this.runtime.createEntity(autonomyEntity);
			if (!created) {
				await runtimeWithUpsert.upsertEntities?.([autonomyEntity]);
			}
			return;
		}

		if (existingEntity.agentId !== this.runtime.agentId) {
			await this.runtime.updateEntity({
				...existingEntity,
				agentId: this.runtime.agentId,
				names:
					existingEntity.names && existingEntity.names.length > 0
						? existingEntity.names
						: autonomyEntity.names,
				metadata: {
					...autonomyEntity.metadata,
					...(existingEntity.metadata ?? {}),
				},
			});
		}
	}

	private async ensureAutonomousContext(): Promise<void> {
		// Ensure world exists
		if (this.runtime.ensureWorldExists) {
			await this.runtime.ensureWorldExists({
				id: this.autonomousWorldId,
				name: "Autonomy World",
				agentId: this.runtime.agentId,
				messageServerId: AUTONOMY_MESSAGE_SERVER_ID,
				metadata: {
					type: "autonomy",
					description: "World for autonomous agent thinking",
				},
			});
		}

		// Ensure room exists
		if (this.runtime.ensureRoomExists) {
			await this.runtime.ensureRoomExists({
				id: this.autonomousRoomId,
				name: "Autonomous Thoughts",
				worldId: this.autonomousWorldId,
				source: "autonomy-service",
				type: ChannelType.SELF,
				metadata: {
					source: "autonomy-service",
					description: "Room for autonomous agent thinking",
				},
			});
		}

		await this.ensureAutonomyEntity();

		// Add agent as participant
		if (this.runtime.addParticipant) {
			await this.runtime.addParticipant(
				this.runtime.agentId,
				this.autonomousRoomId,
			);
			// Also add the autonomy entity as a participant
			await this.runtime.addParticipant(
				this.autonomyEntityId,
				this.autonomousRoomId,
			);
		}
		if (this.runtime.ensureParticipantInRoom) {
			await this.runtime.ensureParticipantInRoom(
				this.runtime.agentId,
				this.autonomousRoomId,
			);
			// Also ensure the autonomy entity is in the room
			await this.runtime.ensureParticipantInRoom(
				this.autonomyEntityId,
				this.autonomousRoomId,
			);
		}

		this.runtime.logger.debug(
			{ src: "autonomy", agentId: this.runtime.agentId },
			`Ensured autonomous room exists with world ID: ${this.autonomousWorldId}`,
		);
	}

	private async buildEntityNameLookup(
		entityIds: Set<UUID>,
	): Promise<Map<UUID, string>> {
		const entries = await Promise.all(
			Array.from(entityIds).map(async (entityId) => {
				if (!this.runtime.getEntityById) {
					return [entityId, String(entityId)] as const;
				}
				const entity = await this.runtime.getEntityById(entityId);
				return [entityId, this.readEntityName(entity, entityId)] as const;
			}),
		);
		return new Map(entries);
	}

	private readEntityName(entity: Entity | null, entityId: UUID): string {
		if (entity && Array.isArray(entity.names) && entity.names.length > 0) {
			const first = entity.names[0];
			if (typeof first === "string" && first.trim().length > 0) {
				return first;
			}
		}
		return String(entityId);
	}

	/**
	 * Perform one iteration of autonomous thinking using the full Eliza agent pipeline.
	 * This processes the message through:
	 * - All registered providers (context gathering)
	 * - The LLM generation pipeline (response creation)
	 * - Action processing (executing decided actions)
	 * - Evaluators (post-response analysis)
	 */
	async performAutonomousThink(): Promise<void> {
		this.runtime.logger.debug(
			{ src: "autonomy", agentId: this.runtime.agentId },
			`Performing autonomous thinking... (${new Date().toLocaleTimeString()})`,
		);

		// Get agent entity
		const agentEntity = this.runtime.getEntityById
			? await this.runtime.getEntityById(this.runtime.agentId)
			: { id: this.runtime.agentId };

		if (!agentEntity) {
			this.runtime.logger.error(
				{ src: "autonomy", agentId: this.runtime.agentId },
				"Failed to get agent entity, skipping autonomous thought",
			);
			return;
		}

		// Get recent autonomous memories for context continuation
		let lastThought: string | undefined;
		let isFirstThought = false;

		const recentMemories = await this.runtime.getMemories({
			roomId: this.autonomousRoomId,
			limit: 3,
			tableName: "memories",
		});

		let lastAgentThought: Memory | null = null;
		for (const memory of recentMemories) {
			if (
				memory.entityId === agentEntity.id &&
				memory.content?.text &&
				memory.content?.metadata &&
				(memory.content.metadata as Record<string, ContentValue>)
					?.isAutonomous === true &&
				(memory.content.metadata as Record<string, ContentValue>)?.type ===
					"autonomous-response"
			) {
				if (
					!lastAgentThought ||
					(memory.createdAt || 0) > (lastAgentThought.createdAt || 0)
				) {
					lastAgentThought = memory;
				}
			}
		}

		if (lastAgentThought?.content?.text) {
			lastThought = lastAgentThought.content.text;
		} else {
			isFirstThought = true;
		}

		// Create prompt with user context + next-step focus
		const mode = this.getAutonomyMode();
		const targetRoomContext = await this.getTargetRoomContextText();
		const autonomyPrompt =
			mode === "task"
				? this.createTaskPrompt({
						lastThought,
						isFirstThought,
						targetRoomContext,
					})
				: this.createContinuousPrompt({
						lastThought,
						isFirstThought,
						targetRoomContext,
					});

		// Create the autonomous message for the full agent pipeline
		// Use autonomyEntityId (not agentId) to avoid "skipping message from self"
		const autonomousMessage: Memory = {
			id: stringToUuid(uuidv4()),
			entityId: this.autonomyEntityId,
			content: {
				text: autonomyPrompt,
				source: "autonomy-service",
				metadata: {
					type: "autonomous-prompt",
					isAutonomous: true,
					isInternalThought: true,
					autonomyMode: mode,
					channelId: "autonomous",
					timestamp: Date.now(),
					isContinuation: !isFirstThought,
				},
			},
			roomId: this.autonomousRoomId,
			agentId: this.runtime.agentId,
			createdAt: Date.now(),
		};

		// Persist the autonomous prompt so UIs can show "autonomy logs" even if the agent doesn't respond.
		// Use a distinct ID to avoid clashing with messageService's message memory creation.
		const baseMetadata =
			typeof autonomousMessage.content.metadata === "object" &&
			autonomousMessage.content.metadata !== null &&
			!Array.isArray(autonomousMessage.content.metadata)
				? (autonomousMessage.content.metadata as Record<string, ContentValue>)
				: {};
		const autonomyLogMemory: Memory = {
			...autonomousMessage,
			id: stringToUuid(uuidv4()),
			content: {
				...autonomousMessage.content,
				metadata: {
					...baseMetadata,
					originalMessageId: autonomousMessage.id,
				},
			},
		};
		try {
			await this.runtime.createMemory(autonomyLogMemory, "memories");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.runtime.logger.warn(
				{ src: "autonomy", agentId: this.runtime.agentId, error: msg },
				"Failed to persist autonomous prompt memory",
			);
		}

		// Response callback - the message service handles memory creation
		const callback = async (content: Content): Promise<Memory[]> => {
			this.runtime.logger.debug(
				{ src: "autonomy", agentId: this.runtime.agentId },
				`Response generated: ${content.text?.substring(0, 100)}...`,
			);
			// Persist response text for UI log views.
			if (typeof content.text === "string" && content.text.trim().length > 0) {
				const responseMemory: Memory = {
					id: stringToUuid(uuidv4()),
					entityId: this.runtime.agentId,
					agentId: this.runtime.agentId,
					roomId: this.autonomousRoomId,
					createdAt: Date.now(),
					content: {
						text: content.text,
						source: "autonomy-service",
						metadata: {
							type: "autonomous-response",
							isAutonomous: true,
							isInternalThought: true,
							autonomyMode: mode,
							channelId: "autonomous",
							timestamp: Date.now(),
						},
					},
				};
				try {
					await this.runtime.createMemory(responseMemory, "memories");
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					this.runtime.logger.warn(
						{ src: "autonomy", agentId: this.runtime.agentId, error: msg },
						"Failed to persist autonomous response memory",
					);
				}
			}
			// Return empty - the message service handles memory storage
			return [];
		};

		this.runtime.logger.debug(
			{ src: "autonomy", agentId: this.runtime.agentId },
			"Processing through full Eliza agent pipeline (providers, actions, evaluators)...",
		);

		// Use the canonical message service if available (full agent pipeline)
		// This ensures: providers gather context, LLM generates response,
		// actions are processed, evaluators run, and memories are stored properly
		if (this.runtime.messageService) {
			try {
				const result = await this.runtime.messageService.handleMessage(
					this.runtime,
					autonomousMessage,
					callback,
				);

				this.runtime.logger.info(
					{ src: "autonomy", agentId: this.runtime.agentId },
					`Pipeline complete - responded: ${result.didRespond}, mode: ${result.mode}`,
				);

				if (result.responseContent?.actions?.length) {
					this.runtime.logger.info(
						{ src: "autonomy", agentId: this.runtime.agentId },
						`Actions executed: ${result.responseContent.actions.join(", ")}`,
					);
				}
			} catch (error) {
				this.runtime.logger.error(
					{ src: "autonomy", agentId: this.runtime.agentId, error },
					"Error in autonomous message processing",
				);
			}
		} else {
			// Fallback to event-based handling for older cores
			this.runtime.logger.warn(
				{ src: "autonomy", agentId: this.runtime.agentId },
				"Using event-based fallback (messageService not available)",
			);
			await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
				runtime: this.runtime,
				message: autonomousMessage,
				callback,
				source: "autonomy-service",
			});
		}
	}

	/**
	 * Create a continuous autonomous operation prompt
	 */
	private createContinuousPrompt(params: {
		lastThought: string | undefined;
		isFirstThought: boolean;
		targetRoomContext: string;
	}): string {
		const template = params.isFirstThought
			? autonomyContinuousFirstTemplate
			: autonomyContinuousContinueTemplate;
		return this.fillAutonomyTemplate(template, {
			targetRoomContext: params.targetRoomContext,
			lastThought: params.lastThought ?? "",
		});
	}

	private createTaskPrompt(params: {
		lastThought: string | undefined;
		isFirstThought: boolean;
		targetRoomContext: string;
	}): string {
		const template = params.isFirstThought
			? autonomyTaskFirstTemplate
			: autonomyTaskContinueTemplate;
		return this.fillAutonomyTemplate(template, {
			targetRoomContext: params.targetRoomContext,
			lastThought: params.lastThought ?? "",
		});
	}

	private fillAutonomyTemplate(
		template: string,
		values: { targetRoomContext: string; lastThought: string },
	): string {
		let output = template.replaceAll(
			"{{targetRoomContext}}",
			values.targetRoomContext,
		);
		output = output.replaceAll("{{lastThought}}", values.lastThought);
		return output;
	}

	/**
	 * Build the autonomy context string for the prompt batcher (Reason phase).
	 * Used by the batcher section's contextBuilder; does not assume messages exist.
	 * WHY: Recurring autonomy drains with an empty message buffer; context must come
	 * from runtime (room context, last thought from memories) and the same templates
	 * as the old performAutonomousThink path so model behavior stays consistent.
	 */
	async buildAutonomyContextForBatcher(): Promise<string> {
		const targetRoomContext = await this.getTargetRoomContextText();
		let lastThought: string | undefined;
		let isFirstThought = false;

		const agentEntity = this.runtime.getEntityById
			? await this.runtime.getEntityById(this.runtime.agentId)
			: { id: this.runtime.agentId };
		if (!agentEntity) {
			return targetRoomContext;
		}

		const recentMemories = await this.runtime.getMemories({
			roomId: this.autonomousRoomId,
			limit: 3,
			tableName: "memories",
		});

		let lastAgentThought: Memory | null = null;
		for (const memory of recentMemories) {
			if (
				memory.entityId === agentEntity.id &&
				memory.content?.text &&
				memory.content?.metadata &&
				(memory.content.metadata as Record<string, ContentValue>)
					?.isAutonomous === true &&
				(memory.content.metadata as Record<string, ContentValue>)?.type ===
					"autonomous-response"
			) {
				if (
					!lastAgentThought ||
					(memory.createdAt || 0) > (lastAgentThought.createdAt || 0)
				) {
					lastAgentThought = memory;
				}
			}
		}

		if (lastAgentThought?.content?.text) {
			lastThought = lastAgentThought.content.text;
		} else {
			isFirstThought = true;
		}

		const mode = this.getAutonomyMode();
		const autonomyPrompt =
			mode === "task"
				? this.createTaskPrompt({
						lastThought,
						isFirstThought,
						targetRoomContext,
					})
				: this.createContinuousPrompt({
						lastThought,
						isFirstThought,
						targetRoomContext,
					});
		return autonomyPrompt;
	}

	/**
	 * Register the autonomy section with the prompt batcher (recurring, contextBuilder-driven).
	 * Idempotent by section id "autonomy". Called when autonomy is enabled.
	 * WHY: One register only (Option A). Batcher owns "when" via minCycleMs and background
	 * tick; we supply "what" (contextBuilder, preamble, schema). Same schema as message
	 * pipeline so the execution facade consumes batcher output without a separate contract.
	 */
	private registerAutonomyBatcherSection(): void {
		if (!this.runtime.promptBatcher) {
			return;
		}
		this.runtime.promptBatcher.think("autonomy", {
			contextBuilder: async (_runtime, _messages) => {
				return await this.buildAutonomyContextForBatcher();
			},
			preamble: [
				"You are in autonomous mode. Output your thought, chosen actions, and text response.",
				"Use the context below for your reasoning. Respond with the structured fields only.",
			].join("\n"),
			schema: [
				{
					field: "thought",
					description: "Your internal reasoning about what to do next",
					required: true,
				},
				{
					field: "providers",
					description:
						"List of providers to use for additional context (comma-separated)",
					required: false,
				},
				{
					field: "actions",
					description: "List of actions to take (comma-separated)",
					required: true,
				},
				{
					field: "text",
					description: "The text response or note to persist",
					required: false,
				},
				{
					field: "simple",
					description: "Whether this is a simple response (true/false)",
					required: false,
				},
			],
			// WHY: Act immediately — as soon as the batcher delivers we run the execution facade so one think → one response → actions + evaluate, same as the message pipeline.
			onResult: async (fields, _meta) => {
				const mode = this.getAutonomyMode();
				// WHY: entityId is autonomyEntityId so the agent is "responding to" the autonomy prompt, not to self; evaluators and attribution stay correct.
				const autonomousMessage: Memory = {
					id: stringToUuid(uuidv4()),
					entityId: this.autonomyEntityId,
					content: {
						text: "",
						source: "autonomy-service",
						metadata: {
							type: "autonomous-prompt",
							isAutonomous: true,
							isInternalThought: true,
							autonomyMode: mode,
							channelId: "autonomous",
							timestamp: Date.now(),
						},
					},
					roomId: this.autonomousRoomId,
					agentId: this.runtime.agentId,
					createdAt: Date.now(),
				};
				try {
					const baseMetadata =
						typeof autonomousMessage.content.metadata === "object" &&
						autonomousMessage.content.metadata !== null &&
						!Array.isArray(autonomousMessage.content.metadata)
							? (autonomousMessage.content.metadata as Record<
									string,
									ContentValue
								>)
							: {};
					const autonomyLogMemory: Memory = {
						...autonomousMessage,
						id: stringToUuid(uuidv4()),
						content: {
							...autonomousMessage.content,
							metadata: {
								...baseMetadata,
								originalMessageId: autonomousMessage.id,
							},
						},
					};
					await this.runtime.createMemory(autonomyLogMemory, "memories");
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					this.runtime.logger.warn(
						{ src: "autonomy", agentId: this.runtime.agentId, error: msg },
						"Failed to persist autonomous prompt memory",
					);
				}
				const callback = async (content: Content): Promise<Memory[]> => {
					this.runtime.logger.debug(
						{ src: "autonomy", agentId: this.runtime.agentId },
						`Autonomy response: ${content.text?.substring(0, 100)}...`,
					);
					if (
						typeof content.text === "string" &&
						content.text.trim().length > 0
					) {
						const responseMemory: Memory = {
							id: stringToUuid(uuidv4()),
							entityId: this.runtime.agentId,
							agentId: this.runtime.agentId,
							roomId: this.autonomousRoomId,
							createdAt: Date.now(),
							content: {
								text: content.text,
								source: "autonomy-service",
								metadata: {
									type: "autonomous-response",
									isAutonomous: true,
									isInternalThought: true,
									autonomyMode: mode,
									channelId: "autonomous",
									timestamp: Date.now(),
								},
							},
						};
						try {
							await this.runtime.createMemory(responseMemory, "memories");
						} catch (e) {
							const m = e instanceof Error ? e.message : String(e);
							this.runtime.logger.warn(
								{ src: "autonomy", agentId: this.runtime.agentId, error: m },
								"Failed to persist autonomous response memory",
							);
						}
					}
					return [];
				};
				await runAutonomyPostResponse(
					this.runtime,
					autonomousMessage,
					fields,
					callback,
				);
			},
			minCycleMs: this.intervalMs,
			// WHY: Fallback ensures the section always delivers something; IGNORE is the safe no-op so we don't run actions on invalid/empty model output.
			fallback: {
				thought: "Autonomy fallback: no response.",
				actions: ["IGNORE"],
				text: "",
				simple: true,
				providers: [],
			},
		});
		this.runtime.logger.debug(
			{ src: "autonomy", agentId: this.runtime.agentId },
			"Registered autonomy section with prompt batcher",
		);
	}

	// Public API methods

	/**
	 * Check if autonomy is currently running
	 */
	isLoopRunning(): boolean {
		return this.isRunning;
	}

	/**
	 * Get current loop interval in milliseconds
	 */
	getLoopInterval(): number {
		return this.intervalMs;
	}

	/**
	 * Set loop interval (recreates the task with new interval)
	 */
	async setLoopInterval(ms: number): Promise<void> {
		const MIN_INTERVAL = 5000;
		const MAX_INTERVAL = 600000;

		if (ms < MIN_INTERVAL) {
			this.runtime.logger.warn(
				{ src: "autonomy", agentId: this.runtime.agentId },
				`Interval too short, minimum is ${MIN_INTERVAL}ms`,
			);
			ms = MIN_INTERVAL;
		}
		if (ms > MAX_INTERVAL) {
			this.runtime.logger.warn(
				{ src: "autonomy", agentId: this.runtime.agentId },
				`Interval too long, maximum is ${MAX_INTERVAL}ms`,
			);
			ms = MAX_INTERVAL;
		}

		this.intervalMs = ms;
		this.runtime.logger.info(
			{ src: "autonomy", agentId: this.runtime.agentId },
			`Loop interval set to ${ms}ms`,
		);

		// WHY: Section is immutable once added; to change minCycleMs we remove and re-register with the new interval.
		if (this.isRunning) {
			this.runtime.promptBatcher?.removeSection("autonomy");
			this.registerAutonomyBatcherSection();
		}
	}

	/**
	 * Get the autonomous room ID
	 */
	getAutonomousRoomId(): UUID {
		return this.autonomousRoomId;
	}

	/**
	 * Enable autonomy — registers the section with the prompt batcher (Option A; no Task).
	 * WHY: No Task creation; one register only. Batcher background tick + minCycleMs drive when the section drains.
	 */
	async enableAutonomy(): Promise<void> {
		this.runtime.enableAutonomy = true;
		if (!this.isRunning) {
			this.registerAutonomyBatcherSection();
			this.isRunning = true;
		}
	}

	/**
	 * Disable autonomy — removes the section from the prompt batcher.
	 * WHY: removeSection("autonomy") stops future drains; no Task to delete.
	 */
	async disableAutonomy(): Promise<void> {
		this.runtime.enableAutonomy = false;
		if (this.isRunning) {
			this.runtime.promptBatcher?.removeSection("autonomy");
			this.isRunning = false;
		}
	}

	/**
	 * Legacy method names for backwards compatibility
	 */
	async startLoop(): Promise<void> {
		await this.enableAutonomy();
	}

	async stopLoop(): Promise<void> {
		await this.disableAutonomy();
	}

	/**
	 * Trigger an autonomous thinking cycle immediately.
	 * Useful for testing or manual intervention without waiting for the interval.
	 * @returns true if thinking was triggered, false if already thinking or an error occurred
	 */
	async triggerThinkNow(): Promise<boolean> {
		if (this.isThinking) {
			this.runtime.logger.info(
				{ src: "autonomy", agentId: this.runtime.agentId },
				"Already thinking, skipping manual trigger",
			);
			return false;
		}

		this.runtime.logger.info(
			{ src: "autonomy", agentId: this.runtime.agentId },
			"Manually triggered autonomous thinking",
		);

		this.isThinking = true;
		try {
			await this.performAutonomousThink();
			return true;
		} catch (error) {
			this.runtime.logger.error(
				{ src: "autonomy", agentId: this.runtime.agentId, error },
				"Error during manually triggered autonomous think",
			);
			return false;
		} finally {
			this.isThinking = false;
		}
	}

	/**
	 * Get current autonomy status
	 */
	getStatus(): AutonomyStatus {
		const enabled = this.runtime.enableAutonomy;
		return {
			enabled,
			running: this.isRunning,
			thinking: false,
			interval: this.intervalMs,
			autonomousRoomId: this.autonomousRoomId,
		};
	}

	/**
	 * Stop the service
	 */
	async stop(): Promise<void> {
		this.runtime.promptBatcher?.removeSection("autonomy");
		this.isRunning = false;
		this.runtime.logger.info(
			{ src: "autonomy", agentId: this.runtime.agentId },
			"Autonomy service stopped completely",
		);
	}

	get capabilityDescription(): string {
		return "Autonomous operation using the prompt batcher for continuous agent thinking and actions";
	}
}
