import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
	AgentFactoryOptions,
	AgentMiddlewareContext,
	AgentMiddleware,
	ActionRegistrationConfig,
	ProviderRegistrationConfig,
	EvaluatorRegistrationConfig,
	ServiceRegistrationConfig,
	ActionExecutionResult,
} from "./agent-integration";
import type { IAgentRuntime } from "./runtime";
import type { Character } from "./agent";

describe("AgentFactoryOptions", () => {
	const mockCharacter: Character = {
		name: "TestAgent",
		description: "Test agent character",
		system: "You are a test agent",
		bio: ["Test bio"],
		lore: ["Test lore"],
		knowledge: ["Test knowledge"],
		messageExamples: [],
		postExamples: [],
		adjectives: ["helpful"],
		people: [],
		topics: [],
		style: {
			all: ["Be helpful"],
			chat: ["Be conversational"],
			post: ["Be informative"],
		},
		clients: [],
		plugins: [],
	};

	it("should accept minimal required character", () => {
		const options: AgentFactoryOptions = {
			character: mockCharacter,
		};
		expect(options.character).toBeDefined();
		expect(options.adapter).toBeUndefined();
	});

	it("should accept all factory options fields", () => {
		const options: AgentFactoryOptions = {
			character: mockCharacter,
			adapter: undefined,
			plugins: [],
			modelProvider: "anthropic",
			modelType: "claude-3-5-sonnet",
			logLevel: "debug",
			settings: {
				CUSTOM_SETTING: "value",
			},
		};
		expect(options.character).toBe(mockCharacter);
		expect(options.modelProvider).toBe("anthropic");
		expect(options.logLevel).toBe("debug");
		expect(options.settings?.CUSTOM_SETTING).toBe("value");
	});

	it("should support various log levels", () => {
		const levels: Array<"debug" | "info" | "warn" | "error"> = [
			"debug",
			"info",
			"warn",
			"error",
		];
		levels.forEach((level) => {
			const options: AgentFactoryOptions = {
				character: mockCharacter,
				logLevel: level,
			};
			expect(options.logLevel).toBe(level);
		});
	});

	it("should allow settings override", () => {
		const options: AgentFactoryOptions = {
			character: mockCharacter,
			settings: {
				API_KEY: "test-key",
				DEBUG: "true",
				TIMEOUT: 5000,
			},
		};
		expect(options.settings?.API_KEY).toBe("test-key");
		expect(options.settings?.DEBUG).toBe("true");
		expect(options.settings?.TIMEOUT).toBe(5000);
	});
});

describe("AgentMiddlewareContext", () => {
	const mockRuntime = {} as IAgentRuntime;

	it("should construct valid middleware context", () => {
		const context: AgentMiddlewareContext = {
			runtime: mockRuntime,
			message: {
				userId: "user-123",
				roomId: "room-456",
				content: {
					text: "Hello, agent!",
				},
			},
			next: async () => {},
			skip: () => {},
		};
		expect(context.message.content.text).toBe("Hello, agent!");
		expect(context.runtime).toBe(mockRuntime);
	});

	it("should support optional message fields", () => {
		const context: AgentMiddlewareContext = {
			runtime: mockRuntime,
			message: {
				content: {
					text: "Minimal message",
				},
			},
			next: async () => {},
			skip: () => {},
		};
		expect(context.message.userId).toBeUndefined();
		expect(context.message.roomId).toBeUndefined();
	});

	it("should support optional state and action", () => {
		const context: AgentMiddlewareContext = {
			runtime: mockRuntime,
			message: {
				content: {
					text: "Test",
				},
			},
			state: {
				context: "test context",
				memory: [],
			},
			action: {
				name: "test-action",
				description: "Test action",
				similes: [],
				examples: [],
				handler: async () => ({ success: true }),
				validate: async () => true,
			},
			next: async () => {},
			skip: () => {},
		};
		expect(context.state?.context).toBe("test context");
		expect(context.action?.name).toBe("test-action");
	});

	it("should support optional provider", () => {
		const context: AgentMiddlewareContext = {
			runtime: mockRuntime,
			message: {
				content: {
					text: "Test",
				},
			},
			provider: {
				get: async () => "provider context",
			},
			next: async () => {},
			skip: () => {},
		};
		expect(context.provider?.get).toBeDefined();
	});

	it("should support message metadata", () => {
		const context: AgentMiddlewareContext = {
			runtime: mockRuntime,
			message: {
				content: {
					text: "Test",
				},
				metadata: {
					source: "telegram",
					priority: "high",
				},
			},
			next: async () => {},
			skip: () => {},
		};
		expect(context.message.metadata?.source).toBe("telegram");
		expect(context.message.metadata?.priority).toBe("high");
	});
});

describe("AgentMiddleware", () => {
	it("should define async middleware signature", async () => {
		const middleware: AgentMiddleware = async (context) => {
			expect(context).toBeDefined();
			await context.next();
		};
		expect(middleware).toBeDefined();
	});

	it("should allow middleware to call skip", async () => {
		const middleware: AgentMiddleware = async (context) => {
			if (context.message.content.text === "skip") {
				context.skip();
			} else {
				await context.next();
			}
		};

		const skipContext: AgentMiddlewareContext = {
			runtime: {} as IAgentRuntime,
			message: {
				content: {
					text: "skip",
				},
			},
			next: async () => {},
			skip: vi.fn(),
		};

		await middleware(skipContext);
		expect(skipContext.skip).toHaveBeenCalled();
	});

	it("should allow middleware chaining via next()", async () => {
		const callOrder: number[] = [];

		const middleware1: AgentMiddleware = async (context) => {
			callOrder.push(1);
			await context.next();
			callOrder.push(3);
		};

		const middleware2: AgentMiddleware = async (context) => {
			callOrder.push(2);
			await context.next();
		};

		let nextCalled = false;
		const context: AgentMiddlewareContext = {
			runtime: {} as IAgentRuntime,
			message: {
				content: {
					text: "test",
				},
			},
			next: async () => {
				if (!nextCalled) {
					nextCalled = true;
					await middleware2(context);
				}
			},
			skip: () => {},
		};

		await middleware1(context);
		expect(callOrder).toEqual([1, 2, 3]);
	});
});

describe("ActionRegistrationConfig", () => {
	const mockRuntime = {
		character: {
			name: "TestAgent",
		},
	} as unknown as IAgentRuntime;

	it("should define required action fields", () => {
		const config: ActionRegistrationConfig = {
			name: "test-action",
			description: "A test action",
			similes: ["test", "trial"],
			examples: [],
			handler: async () => ({ success: true }),
			validate: async () => true,
		};
		expect(config.name).toBe("test-action");
		expect(config.description).toBe("A test action");
	});

	it("should support onRegister lifecycle hook", async () => {
		const onRegister = vi.fn();
		const config: ActionRegistrationConfig = {
			name: "test-action",
			description: "A test action",
			similes: [],
			examples: [],
			handler: async () => ({ success: true }),
			validate: async () => true,
			onRegister,
		};

		await config.onRegister?.(mockRuntime);
		expect(onRegister).toHaveBeenCalledWith(mockRuntime);
	});

	it("should support onInvoke lifecycle hook", async () => {
		const onInvoke = vi.fn();
		const config: ActionRegistrationConfig = {
			name: "test-action",
			description: "A test action",
			similes: [],
			examples: [],
			handler: async () => ({ success: true }),
			validate: async () => true,
			onInvoke,
		};

		const params = { param1: "value1" };
		await config.onInvoke?.(mockRuntime, params);
		expect(onInvoke).toHaveBeenCalledWith(mockRuntime, params);
	});

	it("should support onUnload lifecycle hook", async () => {
		const onUnload = vi.fn();
		const config: ActionRegistrationConfig = {
			name: "test-action",
			description: "A test action",
			similes: [],
			examples: [],
			handler: async () => ({ success: true }),
			validate: async () => true,
			onUnload,
		};

		await config.onUnload?.(mockRuntime);
		expect(onUnload).toHaveBeenCalledWith(mockRuntime);
	});

	it("should support all lifecycle hooks together", async () => {
		const hooks = {
			onRegister: vi.fn(),
			onInvoke: vi.fn(),
			onUnload: vi.fn(),
		};

		const config: ActionRegistrationConfig = {
			name: "full-lifecycle-action",
			description: "Action with all hooks",
			similes: [],
			examples: [],
			handler: async () => ({ success: true }),
			validate: async () => true,
			...hooks,
		};

		await config.onRegister?.(mockRuntime);
		await config.onInvoke?.(mockRuntime, {});
		await config.onUnload?.(mockRuntime);

		expect(hooks.onRegister).toHaveBeenCalled();
		expect(hooks.onInvoke).toHaveBeenCalled();
		expect(hooks.onUnload).toHaveBeenCalled();
	});
});

describe("ProviderRegistrationConfig", () => {
	const mockRuntime = {} as IAgentRuntime;

	it("should define required provider fields", () => {
		const config: ProviderRegistrationConfig = {
			get: async () => "context",
		};
		expect(config.get).toBeDefined();
	});

	it("should support onRegister lifecycle hook", async () => {
		const onRegister = vi.fn();
		const config: ProviderRegistrationConfig = {
			get: async () => "context",
			onRegister,
		};

		await config.onRegister?.(mockRuntime);
		expect(onRegister).toHaveBeenCalledWith(mockRuntime);
	});

	it("should support onUnload lifecycle hook", async () => {
		const onUnload = vi.fn();
		const config: ProviderRegistrationConfig = {
			get: async () => "context",
			onUnload,
		};

		await config.onUnload?.(mockRuntime);
		expect(onUnload).toHaveBeenCalledWith(mockRuntime);
	});
});

describe("EvaluatorRegistrationConfig", () => {
	const mockRuntime = {} as IAgentRuntime;

	it("should define required evaluator fields", () => {
		const config: EvaluatorRegistrationConfig = {
			name: "test-evaluator",
			similes: ["scorer"],
			description: "Test evaluator",
			handler: async () => 1,
		};
		expect(config.name).toBe("test-evaluator");
		expect(config.description).toBe("Test evaluator");
	});

	it("should support onRegister lifecycle hook", async () => {
		const onRegister = vi.fn();
		const config: EvaluatorRegistrationConfig = {
			name: "test-evaluator",
			similes: [],
			description: "Test",
			handler: async () => 1,
			onRegister,
		};

		await config.onRegister?.(mockRuntime);
		expect(onRegister).toHaveBeenCalledWith(mockRuntime);
	});

	it("should support onUnload lifecycle hook", async () => {
		const onUnload = vi.fn();
		const config: EvaluatorRegistrationConfig = {
			name: "test-evaluator",
			similes: [],
			description: "Test",
			handler: async () => 1,
			onUnload,
		};

		await config.onUnload?.(mockRuntime);
		expect(onUnload).toHaveBeenCalledWith(mockRuntime);
	});
});

describe("ServiceRegistrationConfig", () => {
	const mockRuntime = {} as IAgentRuntime;

	it("should define required service fields", () => {
		const config: ServiceRegistrationConfig = {
			name: "test-service",
			description: "Test service",
			getInstance: async () => ({
				start: async () => {},
				stop: async () => {},
			}),
		};
		expect(config.name).toBe("test-service");
		expect(config.getInstance).toBeDefined();
	});

	it("should support onRegister lifecycle hook", async () => {
		const onRegister = vi.fn();
		const config: ServiceRegistrationConfig = {
			name: "test-service",
			description: "Test",
			getInstance: async () => ({
				start: async () => {},
				stop: async () => {},
			}),
			onRegister,
		};

		await config.onRegister?.(mockRuntime);
		expect(onRegister).toHaveBeenCalledWith(mockRuntime);
	});

	it("should support onStart lifecycle hook", async () => {
		const onStart = vi.fn();
		const config: ServiceRegistrationConfig = {
			name: "test-service",
			description: "Test",
			getInstance: async () => ({
				start: async () => {},
				stop: async () => {},
			}),
			onStart,
		};

		await config.onStart?.(mockRuntime);
		expect(onStart).toHaveBeenCalledWith(mockRuntime);
	});

	it("should support onStop lifecycle hook", async () => {
		const onStop = vi.fn();
		const config: ServiceRegistrationConfig = {
			name: "test-service",
			description: "Test",
			getInstance: async () => ({
				start: async () => {},
				stop: async () => {},
			}),
			onStop,
		};

		await config.onStop?.(mockRuntime);
		expect(onStop).toHaveBeenCalledWith(mockRuntime);
	});

	it("should support all lifecycle hooks together", async () => {
		const hooks = {
			onRegister: vi.fn(),
			onStart: vi.fn(),
			onStop: vi.fn(),
		};

		const config: ServiceRegistrationConfig = {
			name: "full-lifecycle-service",
			description: "Service with all hooks",
			getInstance: async () => ({
				start: async () => {},
				stop: async () => {},
			}),
			...hooks,
		};

		await config.onRegister?.(mockRuntime);
		await config.onStart?.(mockRuntime);
		await config.onStop?.(mockRuntime);

		expect(hooks.onRegister).toHaveBeenCalled();
		expect(hooks.onStart).toHaveBeenCalled();
		expect(hooks.onStop).toHaveBeenCalled();
	});
});

describe("ActionExecutionResult", () => {
	it("should define minimal success result", () => {
		const result: ActionExecutionResult = {
			success: true,
			text: "Action completed successfully",
		};
		expect(result.success).toBe(true);
		expect(result.text).toBe("Action completed successfully");
		expect(result.error).toBeUndefined();
	});

	it("should define minimal failure result with error", () => {
		const result: ActionExecutionResult = {
			success: false,
			text: "Action failed",
			error: {
				code: "ACTION_FAILED",
				message: "The action encountered an error",
			},
		};
		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("ACTION_FAILED");
		expect(result.error?.message).toBe("The action encountered an error");
	});

	it("should support error with details", () => {
		const result: ActionExecutionResult = {
			success: false,
			text: "API call failed",
			error: {
				code: "API_ERROR",
				message: "HTTP 500",
				details: {
					statusCode: 500,
					endpoint: "/api/endpoint",
					retryable: true,
				},
			},
		};
		expect(result.error?.details).toBeDefined();
		expect((result.error?.details as Record<string, unknown>)?.statusCode).toBe(
			500,
		);
	});

	it("should support structured data result", () => {
		const result: ActionExecutionResult = {
			success: true,
			text: "Email sent",
			data: {
				messageId: "msg_12345",
				deliveryTime: 250,
				recipients: ["user@example.com"],
			},
		};
		expect(result.data?.messageId).toBe("msg_12345");
		expect(result.data?.deliveryTime).toBe(250);
	});

	it("should support metadata telemetry", () => {
		const result: ActionExecutionResult = {
			success: true,
			text: "API call completed",
			metadata: {
				latencyMs: 1500,
				tokensUsed: 500,
				apiCallCount: 3,
				customMetric: "value",
			},
		};
		expect(result.metadata?.latencyMs).toBe(1500);
		expect(result.metadata?.tokensUsed).toBe(500);
		expect(result.metadata?.apiCallCount).toBe(3);
		expect((result.metadata as Record<string, unknown>)?.customMetric).toBe(
			"value",
		);
	});

	it("should support all fields together", () => {
		const result: ActionExecutionResult = {
			success: true,
			text: "Complex action completed",
			data: {
				id: "result_123",
				items: [1, 2, 3],
			},
			metadata: {
				latencyMs: 2000,
				tokensUsed: 1000,
				apiCallCount: 5,
			},
		};
		expect(result.success).toBe(true);
		expect(result.text).toBe("Complex action completed");
		expect(result.data?.id).toBe("result_123");
		expect(result.metadata?.latencyMs).toBe(2000);
	});
});

describe("agent-integration type coherence", () => {
	it("should allow typical action factory setup", () => {
		const options: AgentFactoryOptions = {
			character: {
				name: "MyAgent",
				description: "My agent",
				system: "You are helpful",
				bio: [],
				lore: [],
				knowledge: [],
				messageExamples: [],
				postExamples: [],
				adjectives: [],
				people: [],
				topics: [],
				style: {
					all: [],
					chat: [],
					post: [],
				},
				clients: [],
				plugins: [],
			},
			modelProvider: "anthropic",
			settings: {
				OPENAI_API_KEY: "sk-...",
			},
		};
		expect(options.character).toBeDefined();
	});

	it("should allow typical middleware setup", async () => {
		const middleware: AgentMiddleware = async (context) => {
			if (context.message.content.text.includes("admin")) {
				context.skip();
				return;
			}
			await context.next();
		};
		expect(middleware).toBeDefined();
	});

	it("should allow typical action registration", async () => {
		const action: ActionRegistrationConfig = {
			name: "send-email",
			description: "Send an email",
			similes: ["mail", "send"],
			examples: [],
			handler: async () => ({
				success: true,
				text: "Email sent",
				data: { messageId: "msg_123" },
			}),
			validate: async () => true,
			onRegister: async (runtime) => {
				console.log("Email action registered for", runtime.character?.name);
			},
		};
		expect(action.name).toBe("send-email");
	});
});
