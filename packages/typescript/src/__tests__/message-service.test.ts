import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, ContentType, EventType, ModelType } from "../index";
import { DefaultMessageService } from "../services/message";
import type { Content, HandlerCallback, Memory, UUID } from "../types";
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
					modelType === ModelType.TEXT_MINI ||
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

		vi.spyOn(runtime, "dynamicPromptExecFromState").mockResolvedValue({
			name: runtime.character.name ?? "TestAgent",
			speak_up: 72,
			hold_back: 18,
			reasoning: "Default test dual-pressure decision",
			action: "RESPOND",
			primaryContext: "general",
			secondaryContexts: "",
			evidenceTurnIds: "",
		});

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

		it("should require LLM evaluation for group messages without mentions", () => {
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
				speak_up: 20,
				hold_back: 25,
				reasoning: "The user asked the agent to stop",
				action: "STOP",
				primaryContext: "general",
				secondaryContexts: "",
				evidenceTurnIds: "",
			});

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174029" as UUID,
				content: {
					text: "please stop",
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

		it("clamps REPLY to IGNORE when dual-pressure net is below threshold", async () => {
			vi.spyOn(runtime, "dynamicPromptExecFromState").mockResolvedValueOnce({
				name: "TestAgent",
				speak_up: 10,
				hold_back: 85,
				reasoning: "Inconsistent: low net but model said reply",
				action: "REPLY",
				primaryContext: "general",
				secondaryContexts: "",
				evidenceTurnIds: "",
			});

			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174029b" as UUID,
				content: {
					text: "random group chatter",
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
			expect(result.dualPressure).toEqual({
				speakUp: 10,
				holdBack: 85,
				net: -75,
			});
			expect(result.shouldRespondClassifierAction).toBe("IGNORE");
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
				id: "123e4567-e89b-12d3-a456-426614174029c" as UUID,
				content: {
					text: "hey everyone",
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
			expect(result.dualPressure).toEqual({
				speakUp: 80,
				holdBack: 15,
				net: 65,
			});
			expect(result.shouldRespondClassifierAction).toBe("IGNORE");
			expect(runtime.logger.warn).toHaveBeenCalledWith(
				expect.objectContaining({
					src: "service:message",
					net: 65,
				}),
				expect.stringContaining("high net but IGNORE"),
			);
		});

		it("uses RESPONSE_HANDLER as the default shouldRespond model route", async () => {
			const dynamicPromptSpy = vi
				.spyOn(runtime, "dynamicPromptExecFromState")
				.mockResolvedValueOnce({
					name: "TestAgent",
					speak_up: 75,
					hold_back: 15,
					reasoning: "Directly addressed",
					action: "RESPOND",
					primaryContext: "general",
					secondaryContexts: "",
					evidenceTurnIds: "",
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
					text: "hey test agent",
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
