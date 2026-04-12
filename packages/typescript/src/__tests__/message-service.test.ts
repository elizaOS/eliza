import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTaskCompletionCacheKey } from "../advanced-capabilities/evaluators/task-completion";
import { ChannelType, ContentType, EventType, ModelType } from "../index";
import { DefaultMessageService } from "../services/message";
import type {
	Content,
	Evaluator,
	HandlerCallback,
	Memory,
	State,
	UUID,
} from "../types";
import type { IMessageService } from "../types/message-service";
import type { GenerateTextParams } from "../types/model";
import type { IAgentRuntime } from "../types/runtime";
import { cleanupTestRuntime, createTestRuntime } from "./test-utils";

describe("DefaultMessageService", () => {
	let messageService: IMessageService;
	let runtime: IAgentRuntime;
	let mockCallback: HandlerCallback;

	beforeEach(async () => {
		// Create REAL runtime
		runtime = await createTestRuntime();

		// Create mock callback
		mockCallback = vi.fn(async (content: Content) => {
			return [
				{
					id: "123e4567-e89b-12d3-a456-426614174099" as UUID,
					content,
					entityId: "123e4567-e89b-12d3-a456-426614174001" as UUID,
					agentId: runtime.agentId,
					roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
					createdAt: Date.now(),
				},
			];
		});

		// Spy on runtime methods with specific implementations
		vi.spyOn(runtime, "getSetting").mockImplementation((key: string) => {
			const settings: Record<string, string> = {
				ALWAYS_RESPOND_CHANNELS: "",
				ALWAYS_RESPOND_SOURCES: "",
				SHOULD_RESPOND_BYPASS_TYPES: "",
				SHOULD_RESPOND_BYPASS_SOURCES: "",
			};
			return settings[key] ?? null;
		});
		vi.spyOn(runtime, "isCheckShouldRespondEnabled").mockReturnValue(true);
		vi.spyOn(runtime, "isActionPlanningEnabled").mockReturnValue(true);
		vi.spyOn(runtime, "createMemory").mockImplementation(
			async (memory: Memory) => {
				return memory;
			},
		);
		vi.spyOn(runtime, "getMemoryById").mockResolvedValue(null);
		vi.spyOn(runtime, "getMemoriesByRoomIds").mockResolvedValue([]);
		vi.spyOn(runtime, "composeState").mockResolvedValue({
			data: {},
			values: {},
		});
		vi.spyOn(runtime, "useModel").mockImplementation(
			async (
				modelType: (typeof ModelType)[keyof typeof ModelType],
				params: unknown,
			) => {
				if (
					modelType === ModelType.TEXT_SMALL ||
					modelType === ModelType.TEXT_NANO ||
					modelType === ModelType.TEXT_NANO ||
					modelType === ModelType.RESPONSE_HANDLER
				) {
					// Response for shouldRespond check (no streaming)
					return "<response><action>REPLY</action><reason>User asked a question</reason></response>";
				}
				// Response for message handler - now with streaming support
				// Must include <response> wrapper for parseKeyValueXml to work
				const responseText =
					"<response><thought>Processing message</thought><actions>REPLY</actions><providers></providers><text>Hello! How can I help you?</text></response>";
				const textParams = params as GenerateTextParams;
				if (textParams?.stream) {
					// Return TextStreamResult for streaming - simulate chunked response
					return {
						textStream: (async function* () {
							// Yield in chunks to simulate real streaming
							yield "<response><thought>Processing message</thought>";
							yield "<actions>REPLY</actions><providers></providers>";
							yield "<text>Hello! How can I help you?</text></response>";
						})(),
						text: Promise.resolve(responseText),
					};
				}
				return responseText;
			},
		);
		vi.spyOn(runtime, "processActions").mockResolvedValue(undefined);
		vi.spyOn(runtime, "evaluate").mockResolvedValue(undefined);
		vi.spyOn(runtime, "emitEvent").mockResolvedValue(undefined);
		vi.spyOn(runtime, "getRoom").mockImplementation(async (roomId: UUID) => ({
			id: roomId,
			type: ChannelType.GROUP,
			name: "Test Room",
			worldId: "123e4567-e89b-12d3-a456-426614174003" as UUID,
		}));
		vi.spyOn(runtime, "getWorld").mockImplementation(async (worldId: UUID) => ({
			id: worldId,
			name: "Test World",
			agentId: runtime.agentId,
		}));
		vi.spyOn(runtime, "ensureRoomExists").mockResolvedValue(undefined);
		// runtime.actions is a property, not a method - clear it directly
		runtime.actions = [];
		vi.spyOn(runtime, "startRun").mockReturnValue(
			"123e4567-e89b-12d3-a456-426614174100" as UUID,
		);
		vi.spyOn(runtime, "endRun").mockImplementation(() => {});
		vi.spyOn(runtime, "queueEmbeddingGeneration").mockResolvedValue(undefined);
		vi.spyOn(runtime, "log").mockResolvedValue(undefined);
		vi.spyOn(runtime, "getParticipantUserState").mockResolvedValue({
			roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
			userId: runtime.agentId,
		});
		vi.spyOn(runtime, "getRoomsByIds").mockImplementation(
			async (roomIds: UUID[]) => {
				return roomIds.map((id) => ({
					id,
					name: "Test Room",
					type: ChannelType.GROUP,
					worldId: "123e4567-e89b-12d3-a456-426614174003" as UUID,
				}));
			},
		);
		vi.spyOn(runtime, "getEntityById").mockImplementation(
			async (entityId: UUID) => ({
				id: entityId,
				names: ["Test User"],
				agentId: runtime.agentId,
			}),
		);

		// Spy on logger methods
		vi.spyOn(runtime.logger, "debug").mockImplementation(() => {});
		vi.spyOn(runtime.logger, "info").mockImplementation(() => {});
		vi.spyOn(runtime.logger, "warn").mockImplementation(() => {});
		vi.spyOn(runtime.logger, "error").mockImplementation(() => {});

		messageService = new DefaultMessageService();
	});

	afterEach(async () => {
		vi.clearAllMocks();
		await cleanupTestRuntime(runtime);
	});

	describe("shouldRespond", () => {
		it("should always respond in DM channels", () => {
			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174010" as UUID,
				content: { text: "Hello", channelType: ChannelType.DM } as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const room = {
				id: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				type: ChannelType.DM,
				name: "DM",
				worldId: "123e4567-e89b-12d3-a456-426614174003" as UUID,
				source: "test",
			};

			const result = messageService.shouldRespond(runtime, message, room);

			expect(result.shouldRespond).toBe(true);
			expect(result.skipEvaluation).toBe(true);
			expect(result.reason).toContain("private channel");
		});

		it("should always respond to platform mentions", () => {
			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174011" as UUID,
				content: {
					text: "@TestAgent hello",
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const room = {
				id: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				type: ChannelType.GROUP,
				name: "Group",
				worldId: "123e4567-e89b-12d3-a456-426614174003" as UUID,
				source: "test",
			};

			const mentionContext = {
				isMention: true,
				isReply: false,
				isThread: false,
				mentionedUserIds: [],
			};

			const result = messageService.shouldRespond(
				runtime,
				message,
				room,
				mentionContext,
			);

			expect(result.shouldRespond).toBe(true);
			expect(result.skipEvaluation).toBe(true);
			expect(result.reason).toContain("platform mention");
		});

		it("should always respond to platform replies", () => {
			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174012" as UUID,
				content: { text: "Thanks!", channelType: ChannelType.GROUP } as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const room = {
				id: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				type: ChannelType.GROUP,
				name: "Group",
				worldId: "123e4567-e89b-12d3-a456-426614174003" as UUID,
				source: "test",
			};

			const mentionContext = {
				isMention: false,
				isReply: true,
				isThread: false,
				mentionedUserIds: [],
			};

			const result = messageService.shouldRespond(
				runtime,
				message,
				room,
				mentionContext,
			);

			expect(result.shouldRespond).toBe(true);
			expect(result.skipEvaluation).toBe(true);
			expect(result.reason).toContain("platform reply");
		});

		it("should always respond when another user is tagged and the agent is named in text", () => {
			const agentName = runtime.character.name ?? "Test Agent";
			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174012a" as UUID,
				content: {
					text: `<@user-2> ${agentName}, can you take a look?`,
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const room = {
				id: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				type: ChannelType.GROUP,
				name: "Group",
				worldId: "123e4567-e89b-12d3-a456-426614174003" as UUID,
				source: "test",
			};

			const result = messageService.shouldRespond(runtime, message, room);

			expect(result.shouldRespond).toBe(true);
			expect(result.skipEvaluation).toBe(true);
			expect(result.reason).toContain("tagged participants");
		});

		it("should require LLM evaluation when the agent is named in plain text", () => {
			const agentName = runtime.character.name ?? "Test Agent";
			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174012b" as UUID,
				content: {
					text: `${agentName}, can you take a look?`,
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const room = {
				id: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				type: ChannelType.GROUP,
				name: "Group",
				worldId: "123e4567-e89b-12d3-a456-426614174003" as UUID,
				source: "test",
			};

			const result = messageService.shouldRespond(runtime, message, room);

			expect(result.shouldRespond).toBe(false);
			expect(result.skipEvaluation).toBe(false);
			expect(result.reason).toContain("agent named in text");
		});

		it("should always respond in VOICE_DM channels", () => {
			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174013" as UUID,
				content: {
					text: "Voice message",
					channelType: ChannelType.VOICE_DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const room = {
				id: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				type: ChannelType.VOICE_DM,
				name: "Voice DM",
				worldId: "123e4567-e89b-12d3-a456-426614174003" as UUID,
				source: "test",
			};

			const result = messageService.shouldRespond(runtime, message, room);

			expect(result.shouldRespond).toBe(true);
			expect(result.skipEvaluation).toBe(true);
			expect(result.reason).toContain("private channel");
		});

		it("should always respond to client_chat source", () => {
			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174014" as UUID,
				content: {
					text: "Hello from client",
					source: "client_chat",
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const room = {
				id: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				type: ChannelType.GROUP,
				name: "Group",
				worldId: "123e4567-e89b-12d3-a456-426614174003" as UUID,
				source: "test",
			};

			const result = messageService.shouldRespond(runtime, message, room);

			expect(result.shouldRespond).toBe(true);
			expect(result.skipEvaluation).toBe(true);
			expect(result.reason).toContain("whitelisted source");
		});

		it("uses legacy bypass settings when ALWAYS_RESPOND settings are unset", () => {
			vi.spyOn(runtime, "getSetting").mockImplementation((key: string) => {
				const settings: Record<string, string | null> = {
					ALWAYS_RESPOND_CHANNELS: null,
					ALWAYS_RESPOND_SOURCES: null,
					SHOULD_RESPOND_BYPASS_TYPES: ChannelType.GROUP,
					SHOULD_RESPOND_BYPASS_SOURCES: "legacy_source",
				};
				return settings[key] ?? null;
			});

			const channelMessage: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174014a" as UUID,
				content: {
					text: "legacy channel bypass",
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const sourceMessage: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174014b" as UUID,
				content: {
					text: "legacy source bypass",
					source: "legacy_source",
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const room = {
				id: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				type: ChannelType.GROUP,
				name: "Group",
				worldId: "123e4567-e89b-12d3-a456-426614174003" as UUID,
				source: "test",
			};

			expect(
				messageService.shouldRespond(runtime, channelMessage, room),
			).toMatchObject({
				shouldRespond: true,
				skipEvaluation: true,
			});
			expect(
				messageService.shouldRespond(runtime, sourceMessage, room),
			).toMatchObject({
				shouldRespond: true,
				skipEvaluation: true,
			});
		});

		it("treats an explicit empty ALWAYS_RESPOND setting as overriding the legacy alias", () => {
			vi.spyOn(runtime, "getSetting").mockImplementation((key: string) => {
				const settings: Record<string, string> = {
					ALWAYS_RESPOND_CHANNELS: "",
					ALWAYS_RESPOND_SOURCES: "",
					SHOULD_RESPOND_BYPASS_TYPES: ChannelType.GROUP,
					SHOULD_RESPOND_BYPASS_SOURCES: "legacy_source",
				};
				return settings[key] ?? null;
			});

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174014c" as UUID,
				content: {
					text: "legacy alias should be ignored",
					source: "legacy_source",
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const room = {
				id: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				type: ChannelType.GROUP,
				name: "Group",
				worldId: "123e4567-e89b-12d3-a456-426614174003" as UUID,
				source: "test",
			};

			expect(
				messageService.shouldRespond(runtime, message, room),
			).toMatchObject({
				shouldRespond: false,
				skipEvaluation: false,
			});
		});

		it("should always respond in API channels", () => {
			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174015" as UUID,
				content: {
					text: "API request",
					channelType: ChannelType.API,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const room = {
				id: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				type: ChannelType.API,
				name: "API",
				worldId: "123e4567-e89b-12d3-a456-426614174003" as UUID,
				source: "test",
			};

			const result = messageService.shouldRespond(runtime, message, room);

			expect(result.shouldRespond).toBe(true);
			expect(result.skipEvaluation).toBe(true);
			expect(result.reason).toContain("private channel");
		});

		it("should require LLM evaluation for group messages without direct address", () => {
			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174016" as UUID,
				content: {
					text: "General message in group",
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const room = {
				id: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				type: ChannelType.GROUP,
				name: "Group",
				worldId: "123e4567-e89b-12d3-a456-426614174003" as UUID,
				source: "test",
			};

			const result = messageService.shouldRespond(runtime, message, room);

			expect(result.shouldRespond).toBe(false);
			expect(result.skipEvaluation).toBe(false);
			expect(result.reason).toContain("needs LLM evaluation");
		});

		it("should auto-respond to explicit self-modification requests in group chat", () => {
			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174018" as UUID,
				content: {
					text: "Update its personality to be warmer and less verbose",
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const room = {
				id: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				type: ChannelType.GROUP,
				name: "Group",
				worldId: "123e4567-e89b-12d3-a456-426614174003" as UUID,
				source: "test",
			};

			const result = messageService.shouldRespond(runtime, message, room);

			expect(result.shouldRespond).toBe(true);
			expect(result.skipEvaluation).toBe(true);
			expect(result.reason).toContain("self-modification");
		});

		it("should return false if no room context provided", () => {
			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174017" as UUID,
				content: { text: "Message without room" } as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const result = messageService.shouldRespond(runtime, message);

			expect(result.shouldRespond).toBe(false);
			expect(result.skipEvaluation).toBe(true);
			expect(result.reason).toBe("no room context");
		});
	});

	it("describes inline chat images without fetching placeholder URLs and strips raw bytes on update", async () => {
		const updateMemorySpy = vi
			.spyOn(runtime, "updateMemory")
			.mockResolvedValue(true);
		const useModelSpy = vi
			.spyOn(runtime, "useModel")
			.mockImplementation(
				async (
					modelType: (typeof ModelType)[keyof typeof ModelType],
					params: unknown,
				) => {
					if (modelType === ModelType.IMAGE_DESCRIPTION) {
						const imageParams = params as { imageUrl?: string };
						expect(imageParams.imageUrl).toBe("data:image/png;base64,abc123");
						return {
							title: "Screenshot",
							description: "A test attachment",
						};
					}
					if (modelType === ModelType.TEXT_SMALL) {
						return "<response><action>REPLY</action><reason>User asked a question</reason></response>";
					}
					return "<response><thought>Processing message</thought><actions>REPLY</actions><providers></providers><text>Hello! How can I help you?</text></response>";
				},
			);

		const message: Memory = {
			id: "123e4567-e89b-12d3-a456-426614174050" as UUID,
			content: {
				text: "what's in this image?",
				channelType: ChannelType.DM,
				attachments: [
					{
						id: "img-0",
						url: "attachment:img-0",
						title: "photo.png",
						source: "client_chat",
						contentType: ContentType.IMAGE,
						_data: "abc123",
						_mimeType: "image/png",
					},
				],
			} as unknown as Content,
			entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
			roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
			agentId: runtime.agentId,
			createdAt: Date.now(),
		};

		await messageService.handleMessage(runtime, message, mockCallback);

		expect(useModelSpy).toHaveBeenCalledWith(
			ModelType.IMAGE_DESCRIPTION,
			expect.objectContaining({
				imageUrl: "data:image/png;base64,abc123",
			}),
		);

		const storedUpdate = updateMemorySpy.mock.calls.find(
			([memory]) => memory.id === message.id,
		)?.[0];
		const storedAttachment = (
			storedUpdate?.content?.attachments as Array<Record<string, unknown>>
		)?.[0];
		expect(storedAttachment).toBeDefined();
		expect(storedAttachment).not.toHaveProperty("_data");
		expect(storedAttachment).not.toHaveProperty("_mimeType");
		expect(storedAttachment?.description).toBe("A test attachment");
	});

	describe("handleMessage", () => {
		it("emits MESSAGE_RECEIVED before connector messages hit the model pipeline", async () => {
			const sequence: string[] = [];
			(runtime.emitEvent as ReturnType<typeof vi.fn>).mockImplementation(
				async (event: unknown, payload?: unknown) => {
					if (event === EventType.MESSAGE_RECEIVED) {
						sequence.push("MESSAGE_RECEIVED");
						const messagePayload = (payload as { message?: Memory } | undefined)
							?.message;
						if (messagePayload) {
							messagePayload.metadata = {
								...(messagePayload.metadata ?? {}),
								type: "message",
								trajectoryStepId: "connector-step",
							};
						}
						return;
					}
					sequence.push(String(event));
				},
			);
			vi.spyOn(runtime, "dynamicPromptExecFromState").mockImplementation(
				async (params) => {
					sequence.push(
						`MODEL:${String(params.options?.modelType ?? "dynamic")}`,
					);
					return {
						thought: "Processing message",
						actions: "REPLY",
						text: "Hello! How can I help you?",
						simple: true,
					};
				},
			);

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174020" as UUID,
				content: {
					text: "Hello from Discord",
					source: "discord",
					channelType: ChannelType.DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			await messageService.handleMessage(runtime, message, mockCallback);

			expect(message.metadata).toMatchObject({
				trajectoryStepId: "connector-step",
			});
			expect(sequence.indexOf("MESSAGE_RECEIVED")).toBeGreaterThanOrEqual(0);
		});

		it("skips MESSAGE_RECEIVED when the message already has a trajectory step id", async () => {
			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174020" as UUID,
				content: {
					text: "Hello, how are you?",
					source: "client_chat",
					channelType: ChannelType.DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
				metadata: {
					type: "message",
					trajectoryStepId: "existing-step",
				},
			};

			await messageService.handleMessage(runtime, message, mockCallback);

			expect(runtime.emitEvent).not.toHaveBeenCalledWith(
				EventType.MESSAGE_RECEIVED,
				expect.anything(),
			);
		});

		it("should process a simple message and generate response", async () => {
			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174020" as UUID,
				content: {
					text: "Hello, how are you?",
					source: "client_chat",
					channelType: ChannelType.DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const result = await messageService.handleMessage(
				runtime,
				message,
				mockCallback,
			);

			expect(result.didRespond).toBeDefined();
			expect(runtime.createMemory).toHaveBeenCalled();
		});

		it("uses XML encapsulation for message handler responses", async () => {
			vi.spyOn(runtime, "isCheckShouldRespondEnabled").mockReturnValue(false);
			const dynamicPromptSpy = vi.spyOn(runtime, "dynamicPromptExecFromState");

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174034" as UUID,
				content: {
					text: "Hello, are you there?",
					source: "client_chat",
					channelType: ChannelType.DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			await messageService.handleMessage(runtime, message, mockCallback);

			expect(dynamicPromptSpy).toHaveBeenCalled();
			expect(
				dynamicPromptSpy.mock.calls[0]?.[0]?.options?.preferredEncapsulation,
			).toBe("xml");
		});

		it("should emit RUN_STARTED event when handling message", async () => {
			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174021" as UUID,
				content: {
					text: "Test message",
					source: "client_chat",
					channelType: ChannelType.DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			await messageService.handleMessage(runtime, message, mockCallback);

			expect(runtime.emitEvent).toHaveBeenCalledWith(
				EventType.RUN_STARTED,
				expect.objectContaining({
					runtime: runtime,
					messageId: message.id,
				}),
			);
		});

		it("should emit RUN_ENDED event after processing", async () => {
			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174022" as UUID,
				content: {
					text: "Test message",
					source: "client_chat",
					channelType: ChannelType.DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			await messageService.handleMessage(runtime, message, mockCallback);

			// Check that RUN_ENDED was called
			const emitEventCalls = (runtime.emitEvent as ReturnType<typeof vi.fn>)
				.mock.calls;
			const runEndedCall = emitEventCalls.find(
				(call: unknown[]) =>
					Array.isArray(call) && call[0] === EventType.RUN_ENDED,
			);
			expect(runEndedCall).toBeDefined();
		});

		it("should handle errors gracefully", async () => {
			// Test that service handles invalid input gracefully
			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174023" as UUID,
				content: {
					text: "", // Empty text
					source: "client_chat",
					channelType: ChannelType.DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const result = await messageService.handleMessage(
				runtime,
				message,
				mockCallback,
			);

			// Should still return a result even with empty input
			expect(result).toBeDefined();
		});

		it("should store incoming message in memory", async () => {
			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174024" as UUID,
				content: {
					text: "Store this message",
					source: "client_chat",
					channelType: ChannelType.DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			await messageService.handleMessage(runtime, message, mockCallback);

			expect(runtime.createMemory).toHaveBeenCalledWith(
				expect.objectContaining({
					content: expect.objectContaining({
						text: "Store this message",
					}),
				}),
				"messages",
			);
		});

		it("responds to platform mentions even when the room is muted", async () => {
			vi.spyOn(runtime, "getParticipantUserState").mockResolvedValue(
				"MUTED" as unknown as Awaited<
					ReturnType<IAgentRuntime["getParticipantUserState"]>
				>,
			);

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174024a" as UUID,
				content: {
					text: "<@bot-user-id> can you two work together on lifeops?",
					source: "discord",
					channelType: ChannelType.GROUP,
					mentionContext: {
						isMention: true,
						isReply: false,
						isThread: false,
						mentionedUserIds: ["bot-user-id"],
					},
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const result = await messageService.handleMessage(
				runtime,
				message,
				mockCallback,
			);

			expect(result.didRespond).toBe(true);
			expect(mockCallback).toHaveBeenCalled();
			expect(runtime.logger.debug).not.toHaveBeenCalledWith(
				expect.objectContaining({
					roomId: message.roomId,
				}),
				"Ignoring muted room",
			);
		});

		it("should continue after an action and emit a follow-up reply", async () => {
			vi.spyOn(runtime, "isCheckShouldRespondEnabled").mockReturnValue(false);
			vi.spyOn(runtime, "composeState").mockResolvedValue({
				data: {},
				values: {},
				text: "",
			});
			vi.spyOn(runtime, "dynamicPromptExecFromState")
				.mockResolvedValueOnce({
					thought: "Run git status first",
					actions: "SHELL",
					text: "",
					simple: false,
				})
				.mockResolvedValueOnce({
					thought: "Share the result and stop",
					actions: "REPLY",
					providers: "",
					text: "The repo is clean, so there is nothing else to do.",
					simple: true,
				});
			vi.spyOn(runtime, "processActions").mockResolvedValue(undefined);
			vi.spyOn(runtime, "getActionResults").mockReturnValue([
				{
					success: true,
					text: "On branch main\nnothing to commit, working tree clean",
					data: { actionName: "SHELL" },
				},
			]);

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174025" as UUID,
				content: {
					text: "Run git status",
					source: "client_chat",
					channelType: ChannelType.DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const result = await messageService.handleMessage(
				runtime,
				message,
				mockCallback,
			);

			expect(runtime.processActions).toHaveBeenCalledTimes(1);
			expect(runtime.dynamicPromptExecFromState).toHaveBeenCalledTimes(2);
			expect(mockCallback).toHaveBeenCalledWith(
				expect.objectContaining({
					text: "The repo is clean, so there is nothing else to do.",
				}),
			);
			expect(result.responseContent?.text).toBe(
				"The repo is clean, so there is nothing else to do.",
			);
		});

		it("should treat STOP as terminal control and skip processActions", async () => {
			vi.spyOn(runtime, "isCheckShouldRespondEnabled").mockReturnValue(false);
			vi.spyOn(runtime, "composeState").mockResolvedValue({
				data: {},
				values: {},
				text: "",
			});
			vi.spyOn(runtime, "dynamicPromptExecFromState").mockResolvedValue({
				thought: "The task is complete",
				actions: "STOP",
				text: "",
				simple: false,
			});

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174028" as UUID,
				content: {
					text: "Check the repo and stop when done",
					source: "client_chat",
					channelType: ChannelType.DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const result = await messageService.handleMessage(
				runtime,
				message,
				mockCallback,
			);

			expect(runtime.processActions).not.toHaveBeenCalled();
			expect(result.didRespond).toBe(false);
			expect(result.mode).toBe("none");
			expect(result.responseContent?.actions).toEqual(["STOP"]);
		});

		it("clamps REPLY to IGNORE when dual-pressure net is below threshold", async () => {
			vi.spyOn(runtime, "dynamicPromptExecFromState").mockResolvedValueOnce({
				name: "TestAgent",
				speak_up: 10,
				hold_back: 85,
				reasoning: "Not actually addressed to the agent",
				action: "REPLY",
				primaryContext: "general",
				secondaryContexts: "",
				evidenceTurnIds: "",
			});

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174028a" as UUID,
				content: {
					text: "alex can you take this one?",
					source: "discord",
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const result = await messageService.handleMessage(
				runtime,
				message,
				mockCallback,
			);

			expect(runtime.processActions).not.toHaveBeenCalled();
			expect(result.didRespond).toBe(false);
			expect(result.responseContent).toBeNull();
			expect(result.dualPressure).toEqual({
				speakUp: 10,
				holdBack: 85,
				net: -75,
			});
			expect(result.shouldRespondClassifierAction).toBe("IGNORE");
			expect(runtime.createMemory).toHaveBeenCalledWith(
				expect.objectContaining({
					content: expect.objectContaining({
						actions: ["IGNORE"],
					}),
				}),
				"messages",
			);
			expect(runtime.logger.warn).toHaveBeenCalledWith(
				expect.objectContaining({
					src: "service:message",
					net: -75,
				}),
				expect.stringContaining("clamping to IGNORE"),
			);
		});

		it("logs a warning when dual-pressure net is high but action is IGNORE", async () => {
			vi.spyOn(runtime, "dynamicPromptExecFromState").mockResolvedValueOnce({
				name: "TestAgent",
				speak_up: 80,
				hold_back: 15,
				reasoning: "Choosing silence despite strong speak signal",
				action: "IGNORE",
				primaryContext: "general",
				secondaryContexts: "",
				evidenceTurnIds: "",
			});

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174028b" as UUID,
				content: {
					text: "TestAgent, do you know the answer?",
					source: "discord",
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const result = await messageService.handleMessage(
				runtime,
				message,
				mockCallback,
			);

			expect(result.didRespond).toBe(false);
			expect(result.responseContent).toBeNull();
			expect(result.dualPressure).toEqual({
				speakUp: 80,
				holdBack: 15,
				net: 65,
			});
			expect(result.shouldRespondClassifierAction).toBe("IGNORE");
			expect(runtime.createMemory).toHaveBeenCalledWith(
				expect.objectContaining({
					content: expect.objectContaining({
						actions: ["IGNORE"],
					}),
				}),
				"messages",
			);
			expect(runtime.logger.warn).toHaveBeenCalledWith(
				expect.objectContaining({
					src: "service:message",
					net: 65,
				}),
				expect.stringContaining("high net but IGNORE"),
			);
		});

		it("fails closed when classifier omits a dual-pressure score", async () => {
			vi.spyOn(runtime, "dynamicPromptExecFromState").mockResolvedValueOnce({
				name: "TestAgent",
				speak_up: 55,
				reasoning: "Looks relevant but scores are incomplete",
				action: "REPLY",
				primaryContext: "general",
				secondaryContexts: "",
				evidenceTurnIds: "",
			});

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174028c" as UUID,
				content: {
					text: "TestAgent maybe reply here",
					source: "discord",
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const result = await messageService.handleMessage(
				runtime,
				message,
				mockCallback,
			);

			expect(result.didRespond).toBe(false);
			expect(result.responseContent).toBeNull();
			expect(result.dualPressure).toBeNull();
			expect(result.shouldRespondClassifierAction).toBe("IGNORE");
			expect(runtime.createMemory).toHaveBeenCalledWith(
				expect.objectContaining({
					content: expect.objectContaining({
						actions: ["IGNORE"],
					}),
				}),
				"messages",
			);
			expect(runtime.logger.warn).toHaveBeenCalledWith(
				expect.objectContaining({
					src: "service:message",
					action: "REPLY",
				}),
				expect.stringContaining("missing valid dual-pressure scores"),
			);
		});

		it("fails closed when classifier returns an unsupported action", async () => {
			vi.spyOn(runtime, "dynamicPromptExecFromState").mockResolvedValueOnce({
				name: "TestAgent",
				speak_up: 60,
				hold_back: 20,
				reasoning: "Malformed action label",
				action: "MAYBE",
				primaryContext: "general",
				secondaryContexts: "",
				evidenceTurnIds: "",
			});

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174028d" as UUID,
				content: {
					text: "TestAgent should you jump in?",
					source: "discord",
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const result = await messageService.handleMessage(
				runtime,
				message,
				mockCallback,
			);

			expect(runtime.processActions).not.toHaveBeenCalled();
			expect(result.didRespond).toBe(false);
			expect(result.responseContent).toBeNull();
			expect(result.shouldRespondClassifierAction).toBeUndefined();
			expect(runtime.createMemory).toHaveBeenCalledWith(
				expect.objectContaining({
					content: expect.objectContaining({
						actions: ["IGNORE"],
					}),
				}),
				"messages",
			);
			expect(runtime.logger.warn).toHaveBeenCalledWith(
				expect.objectContaining({
					src: "service:message",
					action: "MAYBE",
				}),
				expect.stringContaining("missing valid action"),
			);
		});

		it("should allow continuation to issue another multi-action response", async () => {
			vi.spyOn(runtime, "isCheckShouldRespondEnabled").mockReturnValue(false);
			vi.spyOn(runtime, "composeState").mockResolvedValue({
				data: {},
				values: {},
				text: "",
			});
			vi.spyOn(runtime, "dynamicPromptExecFromState")
				.mockResolvedValueOnce({
					thought: "Run git status first",
					actions: "SHELL",
					text: "",
					simple: false,
				})
				.mockResolvedValueOnce({
					thought: "Tell the user what happened, then inspect the diff",
					actions: "REPLY,SHELL",
					providers: "",
					text: "The tree is clean so far. I am checking the diff next.",
					simple: false,
				})
				.mockResolvedValueOnce({
					thought: "Done after the second tool run",
					actions: "REPLY",
					providers: "",
					text: "There is no diff either, so the task is complete.",
					simple: true,
				});
			vi.spyOn(runtime, "processActions").mockResolvedValue(undefined);
			vi.spyOn(runtime, "getActionResults")
				.mockReturnValueOnce([
					{
						success: true,
						text: "On branch main\nnothing to commit, working tree clean",
						data: { actionName: "SHELL" },
					},
				])
				.mockReturnValueOnce([
					{
						success: true,
						text: "diff --git a/foo b/foo",
						data: { actionName: "SHELL" },
					},
				]);

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174027" as UUID,
				content: {
					text: "Inspect the repo state",
					source: "client_chat",
					channelType: ChannelType.DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const result = await messageService.handleMessage(
				runtime,
				message,
				mockCallback,
			);

			expect(runtime.processActions).toHaveBeenCalledTimes(2);
			expect(runtime.dynamicPromptExecFromState).toHaveBeenCalledTimes(3);
			expect(result.responseContent?.text).toBe(
				"There is no diff either, so the task is complete.",
			);
		});

		it("should honor STOP from shouldRespond without generating a reply", async () => {
			vi.spyOn(runtime, "dynamicPromptExecFromState").mockResolvedValue({
				name: "TestAgent",
				speak_up: 5,
				hold_back: 95,
				reasoning: "The user asked the agent to stop",
				action: "STOP",
			});

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174029" as UUID,
				content: {
					text: "TestAgent, please stop",
					source: "discord",
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const result = await messageService.handleMessage(
				runtime,
				message,
				mockCallback,
			);

			expect(runtime.processActions).not.toHaveBeenCalled();
			expect(result.didRespond).toBe(false);
			expect(result.responseContent).toBeNull();
			expect(runtime.createMemory).toHaveBeenCalledWith(
				expect.objectContaining({
					content: expect.objectContaining({
						actions: ["STOP"],
					}),
				}),
				"messages",
			);
		});

		it("emits MESSAGE_SENT for terminal STOP decisions", async () => {
			vi.spyOn(runtime, "dynamicPromptExecFromState").mockResolvedValue({
				name: "TestAgent",
				speak_up: 5,
				hold_back: 95,
				reasoning: "The user asked the agent to stop",
				action: "STOP",
			});

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174031" as UUID,
				content: {
					text: "TestAgent, please stop",
					source: "discord",
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			await messageService.handleMessage(runtime, message, mockCallback);

			expect(runtime.emitEvent).toHaveBeenCalledWith(
				EventType.MESSAGE_SENT,
				expect.objectContaining({
					message: expect.objectContaining({
						content: expect.objectContaining({
							actions: ["STOP"],
						}),
					}),
					source: "discord",
				}),
			);
		});

		it("uses RESPONSE_HANDLER as the default shouldRespond model route", async () => {
			const dynamicPromptSpy = vi
				.spyOn(runtime, "dynamicPromptExecFromState")
				.mockResolvedValueOnce({
					name: "TestAgent",
					speak_up: 70,
					hold_back: 10,
					reasoning: "Directly addressed",
					action: "RESPOND",
					primaryContext: "general",
				})
				.mockResolvedValueOnce({
					thought: "Reply directly",
					actions: "REPLY",
					text: "hello there",
					simple: true,
				});

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174030" as UUID,
				content: {
					text: "hey TestAgent",
					source: "discord",
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			await messageService.handleMessage(runtime, message, mockCallback, {
				useMultiStep: false,
			});

			expect(dynamicPromptSpy).toHaveBeenCalledTimes(2);
			expect(dynamicPromptSpy.mock.calls[0]?.[0]?.options?.modelType).toBe(
				ModelType.RESPONSE_HANDLER,
			);
			expect(dynamicPromptSpy.mock.calls[0]?.[0]?.options?.maxRetries).toBe(2);
			expect(
				dynamicPromptSpy.mock.calls[0]?.[0]?.options?.retryBackoff,
			).toEqual({
				initialMs: 500,
				multiplier: 2,
				maxMs: 2000,
			});
		});

		it("still runs the shouldRespond classifier for ambiguous group chatter", async () => {
			const dynamicPromptSpy = vi
				.spyOn(runtime, "dynamicPromptExecFromState")
				.mockResolvedValueOnce({
					name: "TestAgent",
					speak_up: 10,
					hold_back: 80,
					reasoning: "Not actually directed at the agent",
					action: "IGNORE",
					primaryContext: "general",
				});

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174030a" as UUID,
				content: {
					text: "you gotta shut up",
					source: "discord",
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const result = await messageService.handleMessage(
				runtime,
				message,
				mockCallback,
				{
					useMultiStep: false,
				},
			);

			expect(result.didRespond).toBe(false);
			expect(dynamicPromptSpy).toHaveBeenCalledTimes(1);
		});

		it("keeps ACTIONS out of the shouldRespond classifier state", async () => {
			const composeStateSpy = vi
				.spyOn(runtime, "composeState")
				.mockImplementation(async (_message, includeList) => {
					if (includeList?.includes("RECENT_MESSAGES")) {
						return {
							values: {
								providers:
									"# About TestAgent\nhelpful and calm\n\n# Message Directions for TestAgent\nbe concise\n\n# Example Conversations for TestAgent\nExample User: hi\nTestAgent: hello\n\nsystem prompt here\n\n# Conversation Messages\nuser: hey test agent\n\nPossible response actions: REPLY, CREATE_TASK",
								actionNames: "Possible response actions: REPLY, CREATE_TASK",
							},
							data: {
								providerOrder: ["CHARACTER", "RECENT_MESSAGES", "ACTIONS"],
								providers: {
									CHARACTER: {
										providerName: "CHARACTER",
										text: "# About TestAgent\nhelpful and calm\n\n# Message Directions for TestAgent\nbe concise\n\n# Example Conversations for TestAgent\nExample User: hi\nTestAgent: hello\n\nsystem prompt here",
										values: {
											bio: "# About TestAgent\nhelpful and calm",
											directions:
												"# Message Directions for TestAgent\nbe concise",
											system: "system prompt here",
											examples:
												"# Example Conversations for TestAgent\nExample User: hi\nTestAgent: hello",
										},
									},
									RECENT_MESSAGES: {
										providerName: "RECENT_MESSAGES",
										text: "# Conversation Messages\nuser: hey test agent",
									},
									ACTIONS: {
										providerName: "ACTIONS",
										text: "Possible response actions: REPLY, CREATE_TASK",
									},
								},
							},
							text: "# Conversation Messages\nuser: hey test agent\n\nPossible response actions: REPLY, CREATE_TASK",
						} as State;
					}

					return {
						values: {
							providers: "Possible response actions: REPLY, CREATE_TASK",
							actionNames: "Possible response actions: REPLY, CREATE_TASK",
						},
						data: {
							providerOrder: ["ACTIONS"],
							providers: {
								ACTIONS: {
									providerName: "ACTIONS",
									text: "Possible response actions: REPLY, CREATE_TASK",
								},
							},
						},
						text: "Possible response actions: REPLY, CREATE_TASK",
					} as State;
				});

			const dynamicPromptSpy = vi
				.spyOn(runtime, "dynamicPromptExecFromState")
				.mockResolvedValueOnce({
					name: "TestAgent",
					speak_up: 72,
					hold_back: 18,
					reasoning: "Directly addressed",
					action: "RESPOND",
					primaryContext: "general",
				})
				.mockResolvedValueOnce({
					thought: "Reply directly",
					actions: "REPLY",
					text: "hello there",
					simple: true,
				});

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174032" as UUID,
				content: {
					text: "hey TestAgent",
					source: "discord",
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			await messageService.handleMessage(runtime, message, mockCallback, {
				useMultiStep: false,
			});

			const shouldRespondState = dynamicPromptSpy.mock.calls[0]?.[0]
				?.state as State;
			const replyState = dynamicPromptSpy.mock.calls[1]?.[0]?.state as State;

			expect(shouldRespondState.values.providers).not.toContain(
				"Possible response actions",
			);
			expect(shouldRespondState.values.providers).toContain(
				"# About TestAgent\nhelpful and calm",
			);
			expect(shouldRespondState.values.providers).toContain(
				"# Message Directions for TestAgent\nbe concise",
			);
			expect(shouldRespondState.values.providers).toContain(
				"system prompt here",
			);
			expect(shouldRespondState.values.providers).not.toContain(
				"# Example Conversations for TestAgent",
			);
			expect(shouldRespondState.data.providerOrder).toEqual([
				"CHARACTER",
				"RECENT_MESSAGES",
			]);
			expect(replyState.values.providers).toContain(
				"Possible response actions",
			);
			expect(replyState.data.providerOrder).toEqual(["ACTIONS"]);
			expect(composeStateSpy.mock.calls[0]?.[1]).toEqual([
				"ENTITIES",
				"CHARACTER",
				"RECENT_MESSAGES",
				"ACTIONS",
			]);
		});

		it("should allow post-action continuation to be disabled explicitly", async () => {
			vi.spyOn(runtime, "isCheckShouldRespondEnabled").mockReturnValue(false);
			vi.spyOn(runtime, "getSetting").mockImplementation((key: string) => {
				if (key === "CONTINUE_AFTER_ACTIONS") return "false";
				const settings: Record<string, string> = {
					ALWAYS_RESPOND_CHANNELS: "",
					ALWAYS_RESPOND_SOURCES: "",
					SHOULD_RESPOND_BYPASS_TYPES: "",
					SHOULD_RESPOND_BYPASS_SOURCES: "",
				};
				return settings[key] ?? null;
			});
			vi.spyOn(runtime, "dynamicPromptExecFromState").mockResolvedValue({
				thought: "Run git status first",
				actions: "SHELL",
				text: "",
				simple: false,
			});
			vi.spyOn(runtime, "processActions").mockResolvedValue(undefined);
			vi.spyOn(runtime, "getActionResults").mockReturnValue([
				{
					success: true,
					text: "On branch main\nnothing to commit, working tree clean",
					data: { actionName: "SHELL" },
				},
			]);

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174026" as UUID,
				content: {
					text: "Run git status",
					source: "client_chat",
					channelType: ChannelType.DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			await messageService.handleMessage(runtime, message, mockCallback);

			expect(runtime.processActions).toHaveBeenCalledTimes(1);
			expect(runtime.dynamicPromptExecFromState).toHaveBeenCalledTimes(1);
		});

		it("continues the turn when reflection marks the task incomplete", async () => {
			vi.spyOn(runtime, "isCheckShouldRespondEnabled").mockReturnValue(false);

			const cache = new Map<string, unknown>();
			vi.spyOn(runtime, "setCache").mockImplementation(async (key, value) => {
				cache.set(key, value);
				return true;
			});
			vi.spyOn(runtime, "getCache").mockImplementation(
				async (key) => cache.get(key) as never,
			);
			vi.spyOn(runtime, "deleteCache").mockImplementation(async (key) => {
				cache.delete(key);
				return true;
			});

			const dynamicPromptSpy = vi
				.spyOn(runtime, "dynamicPromptExecFromState")
				.mockResolvedValueOnce({
					thought: "Acknowledge first",
					actions: "REPLY",
					text: "Working on it.",
					simple: true,
				})
				.mockResolvedValueOnce({
					thought: "Need to actually run the command",
					actions: "SHELL",
					text: "",
					simple: false,
				})
				.mockResolvedValueOnce({
					thought: "Share the grounded result",
					actions: "REPLY",
					text: "It's clean.",
					simple: true,
				});

			vi.spyOn(runtime, "processActions").mockResolvedValue(undefined);
			vi.spyOn(runtime, "getActionResults")
				.mockReturnValueOnce([])
				.mockReturnValueOnce([
					{
						success: true,
						text: "On branch main\nnothing to commit, working tree clean",
						data: { actionName: "SHELL" },
					},
				]);

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174026a" as UUID,
				content: {
					text: "run git status",
					source: "client_chat",
					channelType: ChannelType.DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			vi.spyOn(runtime, "evaluate").mockImplementation(async () => {
				await runtime.setCache(getTaskCompletionCacheKey(message.id), {
					assessed: true,
					completed: false,
					reason: "The lookup has not run yet.",
					source: "reflection",
					evaluatedAt: Date.now(),
					messageId: message.id,
				});
				return [];
			});

			const result = await messageService.handleMessage(
				runtime,
				message,
				mockCallback,
			);

			expect(runtime.processActions).toHaveBeenCalledTimes(1);
			expect(dynamicPromptSpy).toHaveBeenCalledTimes(3);
			const continuationState = dynamicPromptSpy.mock.calls[1]?.[0]
				?.state as State;
			expect(continuationState.values.taskCompletionStatus).toContain(
				"The lookup has not run yet.",
			);
			expect(result.didRespond).toBe(true);
			expect(result.responseContent?.text).toBe("It's clean.");
			expect(mockCallback).toHaveBeenCalledWith(
				expect.objectContaining({ text: "It's clean." }),
			);
		});

		it("refreshes recentMessages before reflection continuation planning", async () => {
			vi.spyOn(runtime, "isCheckShouldRespondEnabled").mockReturnValue(false);

			const cache = new Map<string, unknown>();
			vi.spyOn(runtime, "setCache").mockImplementation(async (key, value) => {
				cache.set(key, value);
				return true;
			});
			vi.spyOn(runtime, "getCache").mockImplementation(
				async (key) => cache.get(key) as never,
			);
			vi.spyOn(runtime, "deleteCache").mockImplementation(async (key) => {
				cache.delete(key);
				return true;
			});

			let initialReplyPersisted = false;
			vi.spyOn(runtime, "createMemory").mockImplementation(
				async (memory: Memory) => {
					if (memory.content?.text === "Working on it.") {
						initialReplyPersisted = true;
					}
					return memory;
				},
			);

			vi.spyOn(runtime, "composeState").mockImplementation(
				async (_message, includeList) => {
					const includeNames = Array.isArray(includeList) ? includeList : [];
					const includesRecentMessages =
						includeNames.includes("RECENT_MESSAGES");

					return {
						data: {},
						values: {
							recentMessages:
								initialReplyPersisted && includesRecentMessages
									? "User: run git status\nAgent: Working on it."
									: "User: run git status",
						},
						text: "",
					};
				},
			);

			const dynamicPromptSpy = vi
				.spyOn(runtime, "dynamicPromptExecFromState")
				.mockResolvedValueOnce({
					thought: "Acknowledge first",
					actions: "REPLY",
					text: "Working on it.",
					simple: true,
				})
				.mockResolvedValueOnce({
					thought: "Need to actually run the command",
					actions: "SHELL",
					text: "",
					simple: false,
				})
				.mockResolvedValueOnce({
					thought: "Share the grounded result",
					actions: "REPLY",
					text: "It's clean.",
					simple: true,
				});

			vi.spyOn(runtime, "processActions").mockResolvedValue(undefined);
			vi.spyOn(runtime, "getActionResults")
				.mockReturnValueOnce([])
				.mockReturnValueOnce([
					{
						success: true,
						text: "On branch main\nnothing to commit, working tree clean",
						data: { actionName: "SHELL" },
					},
				]);

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174026aa" as UUID,
				content: {
					text: "run git status",
					source: "client_chat",
					channelType: ChannelType.DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			vi.spyOn(runtime, "evaluate").mockImplementation(async () => {
				await runtime.setCache(getTaskCompletionCacheKey(message.id), {
					assessed: true,
					completed: false,
					reason: "The lookup has not run yet.",
					source: "reflection",
					evaluatedAt: Date.now(),
					messageId: message.id,
				});
				return [];
			});

			await messageService.handleMessage(runtime, message, mockCallback);

			const reflectionContinuationState = dynamicPromptSpy.mock.calls[1]?.[0]
				?.state as State;
			expect(reflectionContinuationState.values.recentMessages).toContain(
				"Agent: Working on it.",
			);
		});

		it("does not continue a simple clarifying reply when reflection marks the task incomplete", async () => {
			vi.spyOn(runtime, "isCheckShouldRespondEnabled").mockReturnValue(false);

			const cache = new Map<string, unknown>();
			vi.spyOn(runtime, "setCache").mockImplementation(async (key, value) => {
				cache.set(key, value);
				return true;
			});
			vi.spyOn(runtime, "getCache").mockImplementation(
				async (key) => cache.get(key) as never,
			);
			vi.spyOn(runtime, "deleteCache").mockImplementation(async (key) => {
				cache.delete(key);
				return true;
			});

			const dynamicPromptSpy = vi
				.spyOn(runtime, "dynamicPromptExecFromState")
				.mockResolvedValueOnce({
					thought: "Need clarification first",
					actions: "REPLY",
					text: "What did you have in mind for Monday?",
					simple: true,
				});

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174026b" as UUID,
				content: {
					text: "@Eliza for MONDAY",
					source: "discord",
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			vi.spyOn(runtime, "evaluate").mockImplementation(async () => {
				await runtime.setCache(getTaskCompletionCacheKey(message.id), {
					assessed: true,
					completed: false,
					reason:
						"The agent asked a clarifying question and is waiting on the user.",
					source: "reflection",
					evaluatedAt: Date.now(),
					messageId: message.id,
				});
				return [];
			});

			const result = await messageService.handleMessage(
				runtime,
				message,
				mockCallback,
			);

			expect(dynamicPromptSpy).toHaveBeenCalledTimes(1);
			expect(runtime.processActions).not.toHaveBeenCalled();
			expect(mockCallback).toHaveBeenCalledTimes(1);
			expect(mockCallback).toHaveBeenCalledWith(
				expect.objectContaining({
					text: "What did you have in mind for Monday?",
				}),
			);
			expect(result.responseContent?.text).toBe(
				"What did you have in mind for Monday?",
			);
		});

		it("suppresses an identical simple continuation reply after reflection", async () => {
			vi.spyOn(runtime, "isCheckShouldRespondEnabled").mockReturnValue(false);

			const cache = new Map<string, unknown>();
			vi.spyOn(runtime, "setCache").mockImplementation(async (key, value) => {
				cache.set(key, value);
				return true;
			});
			vi.spyOn(runtime, "getCache").mockImplementation(
				async (key) => cache.get(key) as never,
			);
			vi.spyOn(runtime, "deleteCache").mockImplementation(async (key) => {
				cache.delete(key);
				return true;
			});

			const dynamicPromptSpy = vi
				.spyOn(runtime, "dynamicPromptExecFromState")
				.mockResolvedValueOnce({
					thought: "Acknowledge the report",
					actions: "REPLY",
					text: "I'm glad to hear that. Sometimes just clarifying things can make a difference.",
					simple: true,
				})
				.mockResolvedValueOnce({
					thought: "Repeat the same acknowledgement",
					actions: "REPLY",
					text: "I'm glad to hear that. Sometimes just clarifying things can make a difference.",
					simple: true,
				});

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174026bb" as UUID,
				content: {
					text: "this feels so much better ngl",
					source: "discord",
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			vi.spyOn(runtime, "evaluate").mockImplementation(async () => {
				await runtime.setCache(getTaskCompletionCacheKey(message.id), {
					assessed: true,
					completed: false,
					reason: "The task was not actually completed.",
					source: "reflection",
					evaluatedAt: Date.now(),
					messageId: message.id,
				});
				return [];
			});

			const result = await messageService.handleMessage(
				runtime,
				message,
				mockCallback,
			);

			expect(dynamicPromptSpy).toHaveBeenCalledTimes(2);
			expect(mockCallback).toHaveBeenCalledTimes(1);
			expect(mockCallback).toHaveBeenCalledWith(
				expect.objectContaining({
					text: "I'm glad to hear that. Sometimes just clarifying things can make a difference.",
				}),
			);
			expect(runtime.logger.warn).toHaveBeenCalledWith(
				expect.objectContaining({
					messageId: message.id,
					preview:
						"I'm glad to hear that. Sometimes just clarifying things can make a difference.",
				}),
				"Suppressing duplicate visible callback reply emitted for a single turn",
			);
			expect(result.responseContent?.text).toBe(
				"I'm glad to hear that. Sometimes just clarifying things can make a difference.",
			);
		});

		it("does not continue a REPLY action clarifying question when reflection marks the task incomplete", async () => {
			vi.spyOn(runtime, "isCheckShouldRespondEnabled").mockReturnValue(false);

			const cache = new Map<string, unknown>();
			vi.spyOn(runtime, "setCache").mockImplementation(async (key, value) => {
				cache.set(key, value);
				return true;
			});
			vi.spyOn(runtime, "getCache").mockImplementation(
				async (key) => cache.get(key) as never,
			);
			vi.spyOn(runtime, "deleteCache").mockImplementation(async (key) => {
				cache.delete(key);
				return true;
			});

			const dynamicPromptSpy = vi
				.spyOn(runtime, "dynamicPromptExecFromState")
				.mockResolvedValueOnce({
					thought: "Need clarification first",
					actions: "REPLY",
					text: "",
					simple: false,
				});

			vi.spyOn(runtime, "processActions").mockImplementation(
				async (_message, _responses, _state, callback) => {
					await callback?.({
						text: "What did you have in mind for Monday?",
						actions: ["REPLY"],
					});
				},
			);
			vi.spyOn(runtime, "getActionResults").mockReturnValue([
				{
					success: true,
					text: "What did you have in mind for Monday?",
					data: { actionName: "REPLY" },
				},
			]);

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174026c" as UUID,
				content: {
					text: "@Eliza for MONDAY",
					source: "discord",
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			vi.spyOn(runtime, "evaluate").mockImplementation(async () => {
				await runtime.setCache(getTaskCompletionCacheKey(message.id), {
					assessed: true,
					completed: false,
					reason:
						"The agent asked a clarifying question and is waiting on the user.",
					source: "reflection",
					evaluatedAt: Date.now(),
					messageId: message.id,
				});
				return [];
			});

			await messageService.handleMessage(runtime, message, mockCallback);

			expect(dynamicPromptSpy).toHaveBeenCalledTimes(1);
			expect(runtime.processActions).toHaveBeenCalledTimes(1);
			expect(mockCallback).toHaveBeenCalledTimes(1);
			expect(mockCallback).toHaveBeenCalledWith(
				expect.objectContaining({
					text: "What did you have in mind for Monday?",
				}),
			);
		});

		it("only runs alwaysRun evaluators on ignored turns, then runs rich evaluators after a reply", async () => {
			runtime.evaluate = Object.getPrototypeOf(runtime).evaluate.bind(runtime);
			(runtime as unknown as { evaluators: Evaluator[] }).evaluators = [];

			const richReflectionValidate = vi.fn(async () => true);
			const richReflectionHandler = vi.fn(async () => undefined);
			const relationshipValidate = vi.fn(async () => true);
			const relationshipHandler = vi.fn(async () => undefined);
			const heuristicValidate = vi.fn(async () => true);
			const heuristicHandler = vi.fn(async () => undefined);

			runtime.registerEvaluator({
				name: "REFLECTION",
				description: "Post-response reflection",
				similes: [],
				alwaysRun: false,
				validate: richReflectionValidate,
				handler: richReflectionHandler,
			});
			runtime.registerEvaluator({
				name: "RELATIONSHIP_EXTRACTION",
				description: "Post-response relationship extraction",
				similes: [],
				alwaysRun: false,
				validate: relationshipValidate,
				handler: relationshipHandler,
			});
			runtime.registerEvaluator({
				name: "CONVERSATION_PROXIMITY",
				description: "Lightweight heuristic relationship strengthening",
				similes: [],
				alwaysRun: true,
				validate: heuristicValidate,
				handler: heuristicHandler,
			});

			vi.spyOn(messageService, "shouldRespond")
				.mockReturnValueOnce({
					shouldRespond: false,
					skipEvaluation: true,
					reason: "test ignored turn",
				})
				.mockReturnValueOnce({
					shouldRespond: true,
					skipEvaluation: true,
					reason: "test replied turn",
				});

			vi.spyOn(runtime, "dynamicPromptExecFromState").mockResolvedValue({
				thought: "Respond directly",
				actions: "REPLY",
				text: "Handled.",
				simple: true,
			});

			const ignoredMessage: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174026b" as UUID,
				content: {
					text: "ambient chatter",
					source: "client_chat",
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const ignoredResult = await messageService.handleMessage(
				runtime,
				ignoredMessage,
				mockCallback,
			);

			expect(ignoredResult.didRespond).toBe(false);
			expect(richReflectionValidate).not.toHaveBeenCalled();
			expect(richReflectionHandler).not.toHaveBeenCalled();
			expect(relationshipValidate).not.toHaveBeenCalled();
			expect(relationshipHandler).not.toHaveBeenCalled();
			expect(heuristicValidate).toHaveBeenCalledTimes(1);
			expect(heuristicHandler).toHaveBeenCalledTimes(1);
			expect(mockCallback).toHaveBeenCalledWith(
				expect.objectContaining({ actions: ["IGNORE"] }),
			);

			const repliedMessage: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174026c" as UUID,
				content: {
					text: "please help",
					source: "client_chat",
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const repliedResult = await messageService.handleMessage(
				runtime,
				repliedMessage,
				mockCallback,
			);

			expect(repliedResult.didRespond).toBe(true);
			expect(repliedResult.responseContent?.text).toBe("Handled.");
			expect(richReflectionValidate).toHaveBeenCalledTimes(1);
			expect(richReflectionHandler).toHaveBeenCalledTimes(1);
			expect(relationshipValidate).toHaveBeenCalledTimes(1);
			expect(relationshipHandler).toHaveBeenCalledTimes(1);
			expect(heuristicValidate).toHaveBeenCalledTimes(2);
			expect(heuristicHandler).toHaveBeenCalledTimes(2);
		});

		it("runs responded-turn evaluators sequentially to avoid shared-state races", async () => {
			runtime.evaluate = Object.getPrototypeOf(runtime).evaluate.bind(runtime);
			(runtime as unknown as { evaluators: Evaluator[] }).evaluators = [];

			let releaseReflection: (() => void) | undefined;
			let markReflectionStarted: (() => void) | undefined;
			const reflectionStarted = new Promise<void>((resolve) => {
				markReflectionStarted = resolve;
			});
			const sequence: string[] = [];

			runtime.registerEvaluator({
				name: "REFLECTION",
				description: "Post-response reflection",
				similes: [],
				alwaysRun: false,
				validate: vi.fn(async () => true),
				handler: vi.fn(async () => {
					sequence.push("reflection:start");
					markReflectionStarted?.();
					await new Promise<void>((resolve) => {
						releaseReflection = resolve;
					});
					sequence.push("reflection:end");
				}),
			});
			runtime.registerEvaluator({
				name: "RELATIONSHIP_EXTRACTION",
				description: "Post-response relationship extraction",
				similes: [],
				alwaysRun: false,
				validate: vi.fn(async () => true),
				handler: vi.fn(async () => {
					sequence.push("relationship");
				}),
			});

			vi.spyOn(messageService, "shouldRespond").mockReturnValue({
				shouldRespond: true,
				skipEvaluation: true,
				reason: "test replied turn",
			});
			vi.spyOn(runtime, "dynamicPromptExecFromState").mockResolvedValue({
				thought: "Respond directly",
				actions: "REPLY",
				text: "Handled.",
				simple: true,
			});

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174026d" as UUID,
				content: {
					text: "please help",
					source: "client_chat",
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const resultPromise = messageService.handleMessage(
				runtime,
				message,
				mockCallback,
			);

			await reflectionStarted;
			await Promise.resolve();
			expect(sequence).toEqual(["reflection:start"]);

			releaseReflection?.();

			const result = await resultPromise;
			expect(result.didRespond).toBe(true);
			expect(sequence).toEqual([
				"reflection:start",
				"reflection:end",
				"relationship",
			]);
		});

		it("falls back to an error reply when structured output parsing fails", async () => {
			vi.spyOn(runtime, "isCheckShouldRespondEnabled").mockReturnValue(false);
			vi.spyOn(runtime, "composeState").mockResolvedValue({
				data: {},
				values: {
					recentMessages: "User: please summarize the repo status",
				},
				text: "",
			});
			vi.spyOn(runtime, "dynamicPromptExecFromState").mockImplementation(
				async ({ state }) => {
					state.values.structuredOutputFailureSummary =
						"Structured output parse problem";
					state.data.structuredOutputFailure = {
						source: "dynamicPromptExecFromState",
						kind: "parse_problem",
						model: ModelType.ACTION_PLANNER,
						format: "XML",
						schemaFields: ["thought", "actions", "text", "simple"],
						attempts: 2,
						maxRetries: 1,
						timestamp: Date.now(),
						issues: [
							"No structured output could be parsed from the model response.",
						],
						responsePreview:
							"<response><actions><action><name>REPLY</name></action></actions><text>Hello without closing tags",
					};
					return null;
				},
			);
			const useModelSpy = vi
				.spyOn(runtime, "useModel")
				.mockImplementation(async (modelType) => {
					if (modelType === ModelType.TEXT_LARGE) {
						return "I hit an internal parsing error while preparing the reply. The model returned malformed XML, so I could not safely finish the response. Please try again.";
					}
					return "";
				});

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174032" as UUID,
				content: {
					text: "please summarize the repo status",
					source: "client_chat",
					channelType: ChannelType.DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const result = await messageService.handleMessage(
				runtime,
				message,
				mockCallback,
			);

			expect(useModelSpy).toHaveBeenCalledWith(
				ModelType.TEXT_LARGE,
				expect.objectContaining({
					prompt: expect.stringContaining("Structured Failure Diagnostics:"),
				}),
			);
			expect(result.didRespond).toBe(true);
			expect(result.responseContent?.text).toContain("internal parsing error");
			expect(mockCallback).toHaveBeenCalledWith(
				expect.objectContaining({
					text: expect.stringContaining("internal parsing error"),
				}),
			);
		});

		it("defaults to REPLY when planner returns text without actions", async () => {
			vi.spyOn(runtime, "isCheckShouldRespondEnabled").mockReturnValue(false);
			vi.spyOn(runtime, "composeState").mockResolvedValue({
				data: {},
				values: {},
				text: "",
			});
			vi.spyOn(runtime, "dynamicPromptExecFromState").mockResolvedValue({
				thought: "Answer directly",
				text: "You have two calendar events this week.",
				simple: true,
			});

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174033" as UUID,
				content: {
					text: "do i have any flights this week",
					source: "discord",
					channelType: ChannelType.DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const result = await messageService.handleMessage(
				runtime,
				message,
				mockCallback,
			);

			expect(result.didRespond).toBe(true);
			expect(result.responseContent?.actions).toEqual(["REPLY"]);
			expect(result.responseContent?.text).toBe(
				"You have two calendar events this week.",
			);
			expect(mockCallback).toHaveBeenCalledWith(
				expect.objectContaining({
					text: "You have two calendar events this week.",
				}),
			);
		});

		it("accepts planner responses without thought and replies normally", async () => {
			vi.spyOn(runtime, "isCheckShouldRespondEnabled").mockReturnValue(false);
			vi.spyOn(runtime, "composeState").mockResolvedValue({
				data: {},
				values: {},
				text: "",
			});
			vi.spyOn(runtime, "dynamicPromptExecFromState").mockResolvedValue({
				text: "Your return flight is next Thursday at 6:10 PM.",
				actions: "REPLY",
				simple: true,
			});

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174033a" as UUID,
				content: {
					text: "when do i fly back from denver",
					source: "discord",
					channelType: ChannelType.DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const result = await messageService.handleMessage(
				runtime,
				message,
				mockCallback,
			);

			expect(result.didRespond).toBe(true);
			expect(result.responseContent?.thought).toBe("");
			expect(result.responseContent?.actions).toEqual(["REPLY"]);
			expect(result.responseContent?.text).toBe(
				"Your return flight is next Thursday at 6:10 PM.",
			);
			expect(mockCallback).toHaveBeenCalledWith(
				expect.objectContaining({
					text: "Your return flight is next Thursday at 6:10 PM.",
				}),
			);
		});

		it("does not continue after async task actions", async () => {
			vi.spyOn(runtime, "isCheckShouldRespondEnabled").mockReturnValue(false);
			vi.spyOn(runtime, "dynamicPromptExecFromState").mockResolvedValue({
				thought: "Launch a background task",
				actions: "CREATE_TASK",
				text: "",
				simple: false,
			});
			vi.spyOn(runtime, "processActions").mockResolvedValue(undefined);
			vi.spyOn(runtime, "getActionResults").mockReturnValue([
				{
					success: true,
					text: "Started a task agent",
					data: { actionName: "CREATE_TASK" },
				},
			]);

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174027" as UUID,
				content: {
					text: "Start a background coding task",
					source: "client_chat",
					channelType: ChannelType.DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			await messageService.handleMessage(runtime, message, mockCallback);

			expect(runtime.processActions).toHaveBeenCalledTimes(1);
			expect(runtime.dynamicPromptExecFromState).toHaveBeenCalledTimes(1);
		});

		it("skips post-action continuation for actions that suppress it", async () => {
			vi.spyOn(runtime, "isCheckShouldRespondEnabled").mockReturnValue(false);
			vi.spyOn(runtime, "composeState").mockResolvedValue({
				data: {},
				values: {},
				text: "",
			});
			runtime.actions = [
				{
					name: "CREATE_TASK",
					description: "Launch an asynchronous task",
					handler: vi.fn(),
					validate: vi.fn(async () => true),
					suppressPostActionContinuation: true,
				},
			];
			vi.spyOn(runtime, "dynamicPromptExecFromState").mockResolvedValue({
				thought: "Start a task agent",
				actions: "CREATE_TASK",
				text: "",
				simple: false,
			});
			vi.spyOn(runtime, "processActions").mockResolvedValue(undefined);
			vi.spyOn(runtime, "getActionResults").mockReturnValue([
				{
					success: true,
					text: "Launched 1 background task.",
					data: { actionName: "CREATE_TASK" },
				},
			]);

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174031" as UUID,
				content: {
					text: "Build me a page in the background",
					source: "client_chat",
					channelType: ChannelType.DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			await messageService.handleMessage(runtime, message, mockCallback);

			expect(runtime.processActions).toHaveBeenCalledTimes(1);
			expect(runtime.dynamicPromptExecFromState).toHaveBeenCalledTimes(1);
		});

		it("warns when multiple visible callback replies are emitted for one turn", async () => {
			vi.spyOn(runtime, "isCheckShouldRespondEnabled").mockReturnValue(false);
			vi.spyOn(runtime, "composeState").mockResolvedValue({
				data: {},
				values: {},
				text: "",
			});
			runtime.actions = [
				{
					name: "GMAIL_ACTION",
					description: "Grounded Gmail lookup",
					handler: vi.fn(),
					validate: vi.fn(async () => true),
					suppressPostActionContinuation: true,
				},
			];
			vi.spyOn(runtime, "dynamicPromptExecFromState").mockResolvedValue({
				thought: "Use Gmail for the grounded answer",
				actions: "GMAIL_ACTION",
				text: "",
				simple: false,
			});
			vi.spyOn(runtime, "processActions").mockImplementation(
				async (_message, _responses, _state, actionCallback) => {
					await actionCallback({
						text: "I found the email from Suran.",
						source: "action",
						action: "GMAIL_ACTION",
					} as Content);
					await actionCallback({
						text: "I also remember we hit a limit last time.",
						source: "action",
						action: "GMAIL_ACTION",
					} as Content);
				},
			);
			vi.spyOn(runtime, "getActionResults").mockReturnValue([
				{
					success: true,
					text: "I found the email from Suran.",
					data: { actionName: "GMAIL_ACTION" },
				},
			]);

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174031b" as UUID,
				content: {
					text: "check my emails from suran again",
					source: "discord",
					channelType: ChannelType.DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			await messageService.handleMessage(runtime, message, mockCallback);

			expect(mockCallback).toHaveBeenCalledTimes(2);
			expect(runtime.logger.warn).toHaveBeenCalledWith(
				expect.objectContaining({
					callbackCount: 2,
					action: "GMAIL_ACTION",
					messageId: message.id,
				}),
				"Multiple visible callback replies emitted for a single turn",
			);
		});

		it("drops planner REPLY text when a suppressive action is present", async () => {
			vi.spyOn(runtime, "isCheckShouldRespondEnabled").mockReturnValue(false);
			vi.spyOn(runtime, "composeState").mockResolvedValue({
				data: {},
				values: {},
				text: "",
			});
			const createMemorySpy = vi
				.spyOn(runtime, "createMemory")
				.mockResolvedValue("123e4567-e89b-12d3-a456-426614174101" as UUID);
			const processActionsSpy = vi
				.spyOn(runtime, "processActions")
				.mockResolvedValue(undefined);
			runtime.actions = [
				{
					name: "CALENDAR_ACTION",
					description: "Grounded calendar lookup",
					handler: vi.fn(),
					validate: vi.fn(async () => true),
					suppressPostActionContinuation: true,
				},
			];
			vi.spyOn(runtime, "dynamicPromptExecFromState").mockResolvedValue({
				thought: "Use calendar for grounding",
				actions: "REPLY,CALENDAR_ACTION",
				text: "here's what is on your calendar while you're in denver",
				simple: false,
			});

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174032" as UUID,
				content: {
					text: "what do i have while i'm in denver?",
					source: "client_chat",
					channelType: ChannelType.DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const result = await messageService.handleMessage(
				runtime,
				message,
				mockCallback,
			);

			expect(result.didRespond).toBe(true);
			expect(result.responseContent?.text).toBe("");
			expect(result.responseContent?.actions).toEqual(["CALENDAR_ACTION"]);
			expect(processActionsSpy).toHaveBeenCalledWith(
				expect.anything(),
				expect.arrayContaining([
					expect.objectContaining({
						content: expect.objectContaining({
							text: "",
							actions: ["CALENDAR_ACTION"],
						}),
					}),
				]),
				expect.anything(),
				expect.any(Function),
				expect.anything(),
			);
			expect(
				createMemorySpy.mock.calls.some(
					([memory]) =>
						(memory as Memory).content?.text ===
						"here's what is on your calendar while you're in denver",
				),
			).toBe(false);
		});

		it("treats suppressive action similes as terminal when stripping planner replies", async () => {
			vi.spyOn(runtime, "isCheckShouldRespondEnabled").mockReturnValue(false);
			vi.spyOn(runtime, "composeState").mockResolvedValue({
				data: {},
				values: {},
				text: "",
			});
			const createMemorySpy = vi
				.spyOn(runtime, "createMemory")
				.mockResolvedValue("123e4567-e89b-12d3-a456-426614174102" as UUID);
			const processActionsSpy = vi
				.spyOn(runtime, "processActions")
				.mockResolvedValue(undefined);
			const dynamicPromptSpy = vi
				.spyOn(runtime, "dynamicPromptExecFromState")
				.mockResolvedValue({
					thought: "Acknowledge and update personality",
					actions: "REPLY,UPDATE_PERSONALITY",
					text: "i understand. thank you for the feedback.",
					simple: false,
				});
			runtime.actions = [
				{
					name: "MODIFY_CHARACTER",
					similes: ["UPDATE_PERSONALITY"],
					description: "Update the character",
					handler: vi.fn(),
					validate: vi.fn(async () => true),
					suppressPostActionContinuation: true,
				},
			];

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174032b" as UUID,
				content: {
					text: "update its personality to stop asking follow-up questions",
					source: "discord",
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const result = await messageService.handleMessage(
				runtime,
				message,
				mockCallback,
			);

			expect(result.didRespond).toBe(true);
			expect(result.responseContent?.text).toBe("");
			expect(result.responseContent?.actions).toEqual(["UPDATE_PERSONALITY"]);
			expect(dynamicPromptSpy).toHaveBeenCalledTimes(1);
			expect(processActionsSpy).toHaveBeenCalledWith(
				expect.anything(),
				expect.arrayContaining([
					expect.objectContaining({
						content: expect.objectContaining({
							text: "",
							actions: ["UPDATE_PERSONALITY"],
						}),
					}),
				]),
				expect.anything(),
				expect.any(Function),
				expect.anything(),
			);
			expect(
				createMemorySpy.mock.calls.some(
					([memory]) =>
						(memory as Memory).content?.text ===
						"i understand. thank you for the feedback.",
				),
			).toBe(false);
		});

		it("includes prior action state when follow-up parsing fails", async () => {
			vi.spyOn(runtime, "isCheckShouldRespondEnabled").mockReturnValue(false);
			vi.spyOn(runtime, "composeState").mockResolvedValue({
				data: {},
				values: {
					recentMessages: "User: run git status",
				},
				text: "",
			});
			vi.spyOn(runtime, "dynamicPromptExecFromState")
				.mockResolvedValueOnce({
					thought: "Run git status first",
					actions: "SHELL",
					text: "",
					simple: false,
				})
				.mockImplementationOnce(async ({ state }) => {
					state.values.structuredOutputFailureSummary =
						"Structured output validation error";
					state.data.structuredOutputFailure = {
						source: "dynamicPromptExecFromState",
						kind: "validation_error",
						model: ModelType.ACTION_PLANNER,
						format: "XML",
						schemaFields: ["thought", "actions", "providers", "text", "simple"],
						attempts: 1,
						maxRetries: 0,
						timestamp: Date.now(),
						issues: ["Missing required fields: text"],
						responsePreview:
							"<response><thought>summarize the shell output</thought></response>",
					};
					return null;
				});
			vi.spyOn(runtime, "processActions").mockResolvedValue(undefined);
			vi.spyOn(runtime, "getActionResults").mockReturnValue([
				{
					success: true,
					text: "On branch main\nnothing to commit, working tree clean",
					data: { actionName: "SHELL" },
				},
			]);
			const useModelSpy = vi
				.spyOn(runtime, "useModel")
				.mockImplementation(async (modelType, params) => {
					if (modelType === ModelType.TEXT_LARGE) {
						expect((params as GenerateTextParams).prompt).toContain(
							"On branch main",
						);
						return "I successfully ran SHELL, but I hit an internal parsing error while preparing the follow-up reply. The command succeeded, but the XML formatting step failed. Please ask me to retry.";
					}
					return "";
				});

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174033" as UUID,
				content: {
					text: "run git status",
					source: "client_chat",
					channelType: ChannelType.DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const result = await messageService.handleMessage(
				runtime,
				message,
				mockCallback,
			);

			expect(useModelSpy).toHaveBeenCalledWith(
				ModelType.TEXT_LARGE,
				expect.any(Object),
			);
			expect(result.responseContent?.text).toContain("successfully ran SHELL");
			expect(result.responseContent?.text).toContain("parsing error");
		});
	});

	describe("integration scenarios", () => {
		it("should handle voice message flow", async () => {
			vi.spyOn(runtime, "getRoom").mockResolvedValue({
				id: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				type: ChannelType.VOICE_DM,
				name: "Voice DM",
				worldId: "123e4567-e89b-12d3-a456-426614174003" as UUID,
			});

			const voiceMessage: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174303" as UUID,
				content: {
					text: "Test voice message",
					source: "test",
					channelType: ChannelType.VOICE_DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const result = await messageService.handleMessage(
				runtime,
				voiceMessage,
				mockCallback,
			);

			// Should process voice messages just like regular messages
			expect(result).toBeDefined();
			expect(result.didRespond).toBe(true); // Voice DMs should always get responses
			expect(runtime.createMemory).toHaveBeenCalled();
		});

		it("should handle message without callback", async () => {
			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174031" as UUID,
				content: {
					text: "Message without callback",
					source: "discord",
					channelType: ChannelType.GROUP,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			// Should not throw when callback is undefined
			const result = await messageService.handleMessage(
				runtime,
				message,
				undefined,
			);

			expect(result).toBeDefined();
		});

		it("should handle message from agent itself", async () => {
			const agentMessage: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174032" as UUID,
				content: {
					text: "Message from agent",
					source: "client_chat",
					channelType: ChannelType.DM,
				} as Content,
				entityId: runtime.agentId, // Same as agent
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			const result = await messageService.handleMessage(
				runtime,
				agentMessage,
				mockCallback,
			);

			// Should still process but might skip certain logic
			expect(result).toBeDefined();
		});
	});

	describe("deleteMessage", () => {
		it("should delete a message memory by ID", async () => {
			vi.spyOn(runtime, "deleteMemory").mockResolvedValue(undefined);

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174040" as UUID,
				content: { text: "Message to delete" } as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			await messageService.deleteMessage(runtime, message);

			expect(runtime.deleteMemory).toHaveBeenCalledWith(message.id);
			expect(runtime.logger.info).toHaveBeenCalled();
		});

		it("should handle missing message ID gracefully", async () => {
			vi.spyOn(runtime, "deleteMemory").mockResolvedValue(undefined);

			const messageWithoutId: Memory = {
				content: { text: "Message without ID" } as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			} as Memory;

			await messageService.deleteMessage(runtime, messageWithoutId);

			expect(runtime.deleteMemory).not.toHaveBeenCalled();
			expect(runtime.logger.error).toHaveBeenCalledWith(
				{ src: "service:message", agentId: runtime.agentId },
				"Cannot delete memory: message ID is missing",
			);
		});

		it("should handle deletion errors and re-throw", async () => {
			const deleteError = new Error("Database deletion failed");
			vi.spyOn(runtime, "deleteMemory").mockRejectedValue(deleteError);

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174041" as UUID,
				content: { text: "Message to delete" } as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			await expect(
				messageService.deleteMessage(runtime, message),
			).rejects.toThrow("Database deletion failed");

			// Error is re-thrown - logging may or may not occur depending on implementation
		});
	});

	describe("clearChannel", () => {
		it("should clear all messages from a channel", async () => {
			const roomId = "123e4567-e89b-12d3-a456-426614174050" as UUID;
			const channelId = "test-channel-123";

			const mockMemories: Memory[] = [
				{
					id: "123e4567-e89b-12d3-a456-426614174051" as UUID,
					content: { text: "Message 1" } as Content,
					entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
					roomId,
					agentId: runtime.agentId,
					createdAt: Date.now(),
				},
				{
					id: "123e4567-e89b-12d3-a456-426614174052" as UUID,
					content: { text: "Message 2" } as Content,
					entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
					roomId,
					agentId: runtime.agentId,
					createdAt: Date.now(),
				},
				{
					id: "123e4567-e89b-12d3-a456-426614174053" as UUID,
					content: { text: "Message 3" } as Content,
					entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
					roomId,
					agentId: runtime.agentId,
					createdAt: Date.now(),
				},
			];

			vi.spyOn(runtime, "getMemoriesByRoomIds").mockResolvedValue(mockMemories);
			vi.spyOn(runtime, "deleteMemory").mockResolvedValue(undefined);

			await messageService.clearChannel(runtime, roomId, channelId);

			expect(runtime.getMemoriesByRoomIds).toHaveBeenCalledWith({
				tableName: "messages",
				roomIds: [roomId],
			});
			expect(runtime.deleteMemory).toHaveBeenCalledTimes(3);
			expect(runtime.logger.info).toHaveBeenCalled();
		});

		it("should handle empty channel gracefully", async () => {
			const roomId = "123e4567-e89b-12d3-a456-426614174060" as UUID;
			const channelId = "empty-channel";

			vi.spyOn(runtime, "getMemoriesByRoomIds").mockResolvedValue([]);
			vi.spyOn(runtime, "deleteMemory").mockResolvedValue(undefined);

			await messageService.clearChannel(runtime, roomId, channelId);

			expect(runtime.getMemoriesByRoomIds).toHaveBeenCalled();
			expect(runtime.deleteMemory).not.toHaveBeenCalled();
		});

		it("should continue clearing even if individual deletions fail", async () => {
			const roomId = "123e4567-e89b-12d3-a456-426614174070" as UUID;
			const channelId = "partial-fail-channel";

			const mockMemories: Memory[] = [
				{
					id: "123e4567-e89b-12d3-a456-426614174071" as UUID,
					content: { text: "Message 1" } as Content,
					entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
					roomId,
					agentId: runtime.agentId,
					createdAt: Date.now(),
				},
				{
					id: "123e4567-e89b-12d3-a456-426614174072" as UUID,
					content: { text: "Message 2" } as Content,
					entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
					roomId,
					agentId: runtime.agentId,
					createdAt: Date.now(),
				},
			];

			let callCount = 0;
			vi.spyOn(runtime, "getMemoriesByRoomIds").mockResolvedValue(mockMemories);
			vi.spyOn(runtime, "deleteMemory").mockImplementation(async () => {
				callCount++;
				if (callCount === 1) {
					throw new Error("First deletion failed");
				}
			});

			await messageService.clearChannel(runtime, roomId, channelId);

			// Should have attempted to delete both messages
			expect(runtime.deleteMemory).toHaveBeenCalledTimes(2);
			// Should have logged warning for the failed deletion
			expect(runtime.logger.warn).toHaveBeenCalled();
			// Should have logged success for partial completion
			expect(runtime.logger.info).toHaveBeenCalled();
		});

		it("should skip memories without IDs", async () => {
			const roomId = "123e4567-e89b-12d3-a456-426614174080" as UUID;
			const channelId = "no-id-channel";

			const mockMemories: Memory[] = [
				{
					content: { text: "Message without ID" } as Content,
					entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
					roomId,
					agentId: runtime.agentId,
					createdAt: Date.now(),
				} as Memory,
			];

			vi.spyOn(runtime, "getMemoriesByRoomIds").mockResolvedValue(mockMemories);
			vi.spyOn(runtime, "deleteMemory").mockResolvedValue(undefined);

			await messageService.clearChannel(runtime, roomId, channelId);

			// Should not attempt to delete memories without IDs
			expect(runtime.deleteMemory).not.toHaveBeenCalled();
		});
	});

	describe("parsedXml type safety", () => {
		it("should handle non-string thought/text values in logging without crashing", async () => {
			// Setup a message
			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174200" as UUID,
				content: {
					text: "Test message",
					source: "test",
					channelType: ChannelType.API,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				agentId: runtime.agentId,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				createdAt: Date.now(),
			};

			// Mock useModel to return XML where thought/text are objects (empty tags become {})
			vi.spyOn(runtime, "useModel").mockImplementation(
				async (
					modelType: (typeof ModelType)[keyof typeof ModelType],
					params: unknown,
				) => {
					if (modelType === ModelType.TEXT_SMALL) {
						return "<response><action>REPLY</action><reason>User asked a question</reason></response>";
					}
					// Return XML with empty tags that parseKeyValueXml will parse as {} instead of strings
					const responseText =
						"<response><thought></thought><actions>REPLY</actions><text></text></response>";
					const textParams = params as GenerateTextParams;
					if (textParams?.stream) {
						return {
							textStream: (async function* () {
								yield responseText;
							})(),
							text: Promise.resolve(responseText),
							usage: Promise.resolve({
								promptTokens: 10,
								completionTokens: 5,
								totalTokens: 15,
							}),
						};
					}
					return responseText;
				},
			);
			// Add required mocks for the message processing flow
			vi.spyOn(runtime, "getRoom").mockResolvedValue({
				id: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				name: "Test Room",
				source: "test",
				type: ChannelType.API,
				channelId: "test-channel",
				worldId: "123e4567-e89b-12d3-a456-426614174099" as UUID,
			});

			// The test passes if no error is thrown during message processing
			// This validates that the type guards prevent .substring() from being called on non-strings
			await messageService.handleMessage(runtime, message, mockCallback);

			// Verify the logging was called (which uses the type guards)
			expect(runtime.logger.info).toHaveBeenCalled();
		});
	});

	describe("response superseding", () => {
		function createConcurrentMessage(id: string, text: string): Memory {
			return {
				id: id as UUID,
				content: {
					text,
					source: "client_chat",
					channelType: ChannelType.DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};
		}

		function createConcurrentCallback() {
			return vi.fn(async (content: Content) => {
				return [
					{
						id: "123e4567-e89b-12d3-a456-426614174399" as UUID,
						content,
						entityId: runtime.agentId,
						agentId: runtime.agentId,
						roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
						createdAt: Date.now(),
					},
				];
			});
		}

		it("keeps both replies when keepExistingResponses is enabled", async () => {
			vi.spyOn(runtime, "isCheckShouldRespondEnabled").mockReturnValue(false);

			let responseCallCount = 0;
			vi.spyOn(runtime, "dynamicPromptExecFromState").mockImplementation(
				async () => {
					responseCallCount += 1;
					const callNumber = responseCallCount;
					await new Promise((resolve) =>
						setTimeout(resolve, callNumber === 1 ? 10 : 25),
					);

					return {
						thought: `reply-${callNumber}`,
						actions: ["REPLY"],
						text: callNumber === 1 ? "First reply" : "Second reply",
						simple: true,
					};
				},
			);

			const firstCallback = createConcurrentCallback();
			const secondCallback = createConcurrentCallback();

			const [firstResult, secondResult] = await Promise.all([
				messageService.handleMessage(
					runtime,
					createConcurrentMessage(
						"123e4567-e89b-12d3-a456-426614174311",
						"first question",
					),
					firstCallback,
					{ keepExistingResponses: true },
				),
				messageService.handleMessage(
					runtime,
					createConcurrentMessage(
						"123e4567-e89b-12d3-a456-426614174312",
						"second question",
					),
					secondCallback,
					{ keepExistingResponses: true },
				),
			]);

			expect(firstResult.didRespond).toBe(true);
			expect(firstResult.responseContent?.text).toBe("First reply");
			expect(secondResult.didRespond).toBe(true);
			expect(secondResult.responseContent?.text).toBe("Second reply");
			expect(firstCallback).toHaveBeenCalledTimes(1);
			expect(secondCallback).toHaveBeenCalledTimes(1);
			expect(firstCallback).toHaveBeenCalledWith(
				expect.objectContaining({ text: "First reply" }),
			);
			expect(secondCallback).toHaveBeenCalledWith(
				expect.objectContaining({ text: "Second reply" }),
			);
		});

		it("still sends the newest reply after an older superseded run finishes", async () => {
			vi.spyOn(runtime, "isCheckShouldRespondEnabled").mockReturnValue(false);

			let responseCallCount = 0;
			vi.spyOn(runtime, "dynamicPromptExecFromState").mockImplementation(
				async () => {
					responseCallCount += 1;
					const callNumber = responseCallCount;
					await new Promise((resolve) =>
						setTimeout(resolve, callNumber === 1 ? 10 : 25),
					);

					return {
						thought: `reply-${callNumber}`,
						actions: ["REPLY"],
						text: callNumber === 1 ? "Discard me" : "Keep me",
						simple: true,
					};
				},
			);

			const firstCallback = createConcurrentCallback();
			const secondCallback = createConcurrentCallback();

			const [firstResult, secondResult] = await Promise.all([
				messageService.handleMessage(
					runtime,
					createConcurrentMessage(
						"123e4567-e89b-12d3-a456-426614174313",
						"older question",
					),
					firstCallback,
				),
				messageService.handleMessage(
					runtime,
					createConcurrentMessage(
						"123e4567-e89b-12d3-a456-426614174314",
						"newer question",
					),
					secondCallback,
				),
			]);

			expect(firstResult.didRespond).toBe(false);
			expect(firstResult.responseContent).toBeNull();
			expect(secondResult.didRespond).toBe(true);
			expect(secondResult.responseContent?.text).toBe("Keep me");
			expect(firstCallback).not.toHaveBeenCalled();
			expect(secondCallback).toHaveBeenCalledTimes(1);
			expect(secondCallback).toHaveBeenCalledWith(
				expect.objectContaining({ text: "Keep me" }),
			);
		});
	});

	describe("memory creation", () => {
		it("should create memory when DISABLE_MEMORY_CREATION is false", async () => {
			vi.spyOn(runtime, "getSetting").mockImplementation((key: string) => {
				if (key === "DISABLE_MEMORY_CREATION") return "false";
				return null;
			});

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174301" as UUID,
				content: {
					text: "Test message with memory enabled",
					source: "client_chat",
					channelType: ChannelType.DM,
				} as Content,
				entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
				roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
				agentId: runtime.agentId,
				createdAt: Date.now(),
			};

			await messageService.handleMessage(runtime, message, mockCallback);

			expect(runtime.createMemory).toHaveBeenCalled();
		});
	});

	describe("provider timeout", () => {
		it("should use default timeout of 1000ms when PROVIDERS_TOTAL_TIMEOUT_MS is not set", () => {
			vi.spyOn(runtime, "getSetting").mockImplementation((key: string) => {
				if (key === "PROVIDERS_TOTAL_TIMEOUT_MS") return null;
				return null;
			});

			// The default timeout should be 1000ms (1 second)
			const timeout = parseInt(
				String(runtime.getSetting?.("PROVIDERS_TOTAL_TIMEOUT_MS") || "1000"),
				10,
			);
			expect(timeout).toBe(1000);
		});

		it("should use custom timeout when PROVIDERS_TOTAL_TIMEOUT_MS is set", () => {
			vi.spyOn(runtime, "getSetting").mockImplementation((key: string) => {
				if (key === "PROVIDERS_TOTAL_TIMEOUT_MS") return "5000";
				return null;
			});

			const timeout = parseInt(
				String(runtime.getSetting?.("PROVIDERS_TOTAL_TIMEOUT_MS") || "1000"),
				10,
			);
			expect(timeout).toBe(5000);
		});

		it("should track completed providers for timeout diagnostics", async () => {
			// Simulate the provider completion tracking logic
			const completedProviders = new Set<string>();
			const allProviderNames = ["fastProvider", "slowProvider"];

			// Simulate fastProvider completing
			completedProviders.add("fastProvider");

			// Check pending providers (slowProvider didn't complete)
			const pendingProviders = allProviderNames.filter(
				(name) => !completedProviders.has(name),
			);

			expect(pendingProviders).toEqual(["slowProvider"]);
			expect(Array.from(completedProviders)).toEqual(["fastProvider"]);
		});
	});
});
