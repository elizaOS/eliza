import { describe, it, expect, vi, beforeEach } from "vitest";
import { requestSecretFormAction } from "../actions/requestSecretForm";
import type {
  IAgentRuntime,
  Memory,
  HandlerCallback,
  State,
  UUID,
  Content,
} from "@elizaos/core";
import { ChannelType, MemoryType } from "@elizaos/core";

// Mock dependencies
vi.mock("@elizaos/core", async () => {
  const actual = await vi.importActual("@elizaos/core");
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    elizaLogger: {
      info: vi.fn(),
      error: vi.fn(),
    },
    parseJSONObjectFromText: vi.fn(),
  };
});

/**
 * Interface for the minimal form service methods needed in tests
 */
interface TestFormService {
  createSecretForm: ReturnType<typeof vi.fn>;
}

/**
 * Creates a properly typed test Memory object
 */
function createTestMemory(text: string, entityId: string): Memory {
  return {
    id: "test-memory-id" as UUID,
    roomId: "test-room-id" as UUID,
    entityId: entityId as UUID,
    agentId: "test-agent-id" as UUID,
    content: {
      text,
      channelType: ChannelType.GROUP,
    } as Content,
    createdAt: Date.now(),
    metadata: { type: MemoryType.MESSAGE },
  } as Memory;
}

/**
 * Creates a minimal test runtime for action testing
 */
function createTestRuntime(formService: TestFormService | null): IAgentRuntime {
  return {
    agentId: "agent-123" as UUID,
    getService: vi.fn().mockReturnValue(formService),
    getSetting: vi.fn().mockReturnValue(null),
  } as unknown as IAgentRuntime;
}

describe("requestSecretFormAction", () => {
  let testRuntime: IAgentRuntime;
  let testFormService: TestFormService;
  let testCallback: HandlerCallback;
  let testState: State;

  beforeEach(() => {
    vi.clearAllMocks();

    testFormService = {
      createSecretForm: vi.fn().mockResolvedValue({
        url: "https://test.ngrok.io/form/123",
        sessionId: "123",
      }),
    };

    testRuntime = createTestRuntime(testFormService);

    testCallback = vi.fn();

    testState = {
      values: {},
      data: {},
      text: "",
    };
  });

  describe("validate", () => {
    it("should return true when service exists and keywords match", async () => {
      const message = createTestMemory("I need you to request secret from me", "user-123");

      const result = await requestSecretFormAction.validate(
        testRuntime,
        message,
      );
      expect(result).toBe(true);
    });

    it("should return false when service does not exist", async () => {
      const runtimeWithNoService = createTestRuntime(null);

      const message = createTestMemory("request secret", "user-123");

      const result = await requestSecretFormAction.validate(
        runtimeWithNoService,
        message,
      );
      expect(result).toBe(false);
    });

    it("should match various keywords", async () => {
      const testCases = [
        "request secret from user",
        "need information about api",
        "collect secret data",
        "create form for credentials",
        "ask for api key",
        "request credentials",
      ];

      for (const text of testCases) {
        const message = createTestMemory(text, "user-123");

        const result = await requestSecretFormAction.validate(
          testRuntime,
          message,
        );
        expect(result).toBe(true);
      }
    });

    it("should return false for non-matching text", async () => {
      const message = createTestMemory("hello world", "user-123");

      const result = await requestSecretFormAction.validate(
        testRuntime,
        message,
      );
      expect(result).toBe(false);
    });
  });

  describe("handler", () => {
    it("should create form for API key request", async () => {
      const message = createTestMemory("Request my OpenAI API key", "user-123");

      await requestSecretFormAction.handler(
        testRuntime,
        message,
        testState,
        {},
        testCallback,
      );

      expect(testFormService.createSecretForm).toHaveBeenCalledWith(
        expect.objectContaining({
          secrets: expect.arrayContaining([
            expect.objectContaining({
              key: "OPENAI_API_KEY",
              config: expect.objectContaining({
                type: "api_key",
                description: "OpenAI API Key",
              }),
            }),
          ]),
        }),
        expect.objectContaining({
          level: "user",
          userId: "user-123",
          agentId: "agent-123",
        }),
        expect.any(Function),
      );

      expect(testCallback).toHaveBeenCalledWith({
        text: expect.stringContaining("https://test.ngrok.io/form/123"),
        data: {
          formUrl: "https://test.ngrok.io/form/123",
          sessionId: "session-123",
          expiresAt: expect.any(Number),
        },
      });
    });

    it("should handle multiple API keys", async () => {
      // Ensure parseJSONObjectFromText returns null for natural language
      const parseJSON = await import("@elizaos/core").then(
        (m) => m.parseJSONObjectFromText,
      );
      vi.mocked(parseJSON).mockReturnValue(null);

      const message = createTestMemory("I need you to collect my OpenAI and Anthropic API keys", "user-123");

      await requestSecretFormAction.handler(
        testRuntime,
        message,
        testState,
        {},
        testCallback,
      );

      const formCall = vi.mocked(testFormService.createSecretForm).mock
        .calls[0];
      const request = formCall[0];

      expect(request.secrets).toHaveLength(2);
      const keys = request.secrets.map((s: { key: string }) => s.key);
      expect(keys).toContain("OPENAI_API_KEY");
      expect(keys).toContain("ANTHROPIC_API_KEY");
    });

    it("should handle webhook URL request", async () => {
      const message = createTestMemory("Create a form for webhook configuration", "user-123");

      await requestSecretFormAction.handler(
        testRuntime,
        message,
        testState,
        {},
        testCallback,
      );

      const formCall = vi.mocked(testFormService.createSecretForm).mock
        .calls[0];
      const request = formCall[0];

      expect(request.secrets[0]).toMatchObject({
        key: "WEBHOOK_URL",
        config: {
          type: "url",
          description: "Webhook URL",
        },
      });
    });

    it("should parse JSON parameters", async () => {
      const parseJSON = await import("@elizaos/core").then(
        (m) => m.parseJSONObjectFromText,
      );
      vi.mocked(parseJSON).mockReturnValue({
        secrets: [
          {
            key: "CUSTOM_KEY",
            description: "Custom Secret",
            type: "secret",
            required: false,
          },
        ],
        title: "Custom Form",
        description: "Custom Description",
        mode: "inline",
        expiresIn: 600000,
      });

      const message = createTestMemory('{"secrets": [...]}', "user-123");

      await requestSecretFormAction.handler(
        testRuntime,
        message,
        testState,
        {},
        testCallback,
      );

      const formCall = vi.mocked(testFormService.createSecretForm).mock
        .calls[0];
      const request = formCall[0];

      expect(request.title).toBe("Custom Form");
      expect(request.description).toBe("Custom Description");
      expect(request.mode).toBe("inline");
      expect(request.expiresIn).toBe(600000);
    });

    it("should handle custom expiration times", async () => {
      // Ensure parseJSONObjectFromText returns null for natural language
      const parseJSON = await import("@elizaos/core").then(
        (m) => m.parseJSONObjectFromText,
      );
      vi.mocked(parseJSON).mockReturnValue(null);

      const message = createTestMemory("Create a form that expires in 5 minutes", "user-123");

      await requestSecretFormAction.handler(
        testRuntime,
        message,
        testState,
        {},
        testCallback,
      );

      const formCall = vi.mocked(testFormService.createSecretForm).mock
        .calls[0];
      const request = formCall[0];

      expect(request.expiresIn).toBe(5 * 60 * 1000);
    });

    it("should handle hour expiration", async () => {
      // Ensure parseJSONObjectFromText returns null for natural language
      const parseJSON = await import("@elizaos/core").then(
        (m) => m.parseJSONObjectFromText,
      );
      vi.mocked(parseJSON).mockReturnValue(null);

      const message = createTestMemory("Create a form that expires in 2 hours", "user-123");

      await requestSecretFormAction.handler(
        testRuntime,
        message,
        testState,
        {},
        testCallback,
      );

      const formCall = vi.mocked(testFormService.createSecretForm).mock
        .calls[0];
      const request = formCall[0];

      expect(request.expiresIn).toBe(2 * 60 * 60 * 1000);
    });

    it("should use inline mode when specified", async () => {
      const message = createTestMemory("Create a quick inline form for API key", "user-123");

      await requestSecretFormAction.handler(
        testRuntime,
        message,
        testState,
        {},
        testCallback,
      );

      const formCall = vi.mocked(testFormService.createSecretForm).mock
        .calls[0];
      const request = formCall[0];

      expect(request.mode).toBe("inline");
    });

    it("should handle credit card request", async () => {
      // Ensure parseJSONObjectFromText returns null for natural language
      const parseJSON = await import("@elizaos/core").then(
        (m) => m.parseJSONObjectFromText,
      );
      vi.mocked(parseJSON).mockReturnValue(null);

      const message = createTestMemory("Please request my credit card information", "user-123");

      await requestSecretFormAction.handler(
        testRuntime,
        message,
        testState,
        {},
        testCallback,
      );

      const formCall = vi.mocked(testFormService.createSecretForm).mock
        .calls[0];
      const request = formCall[0];

      expect(request.secrets[0]).toMatchObject({
        key: "CREDIT_CARD",
        config: {
          type: "creditcard",
          description: "Credit Card Number",
        },
      });
    });

    it("should handle service not available", async () => {
      const runtimeWithNoService = createTestRuntime(null);

      const message = createTestMemory("Request API key", "user-123");

      const result = await requestSecretFormAction.handler(
        runtimeWithNoService,
        message,
        testState,
        {},
        testCallback,
      );

      expect(result).toBe(false);
      expect(testCallback).toHaveBeenCalledWith({
        text: "Secret form service is not available.",
        error: true,
      });
    });

    it("should handle no secrets specified", async () => {
      const parseJSON = await import("@elizaos/core").then(
        (m) => m.parseJSONObjectFromText,
      );
      vi.mocked(parseJSON).mockReturnValue({
        secrets: [],
      });

      const message = createTestMemory('{"secrets": []}', "user-123");

      const result = await requestSecretFormAction.handler(
        testRuntime,
        message,
        testState,
        {},
        testCallback,
      );

      expect(result).toBe(false);
      expect(testCallback).toHaveBeenCalledWith({
        text: "Please specify what secrets you need to collect.",
        error: true,
      });
    });

    it("should handle form creation errors", async () => {
      // Make sure parseJSONObjectFromText returns null for natural language
      const parseJSON = await import("@elizaos/core").then(
        (m) => m.parseJSONObjectFromText,
      );
      vi.mocked(parseJSON).mockReturnValue(null);

      vi.mocked(testFormService.createSecretForm).mockRejectedValue(
        new Error("Ngrok tunnel failed"),
      );

      const message = createTestMemory("Request API key", "user-123");

      const result = await requestSecretFormAction.handler(
        testRuntime,
        message,
        testState,
        {},
        testCallback,
      );

      expect(result).toBe(false);
      expect(testCallback).toHaveBeenCalledWith({
        text: "Error creating secret form: Ngrok tunnel failed",
        error: true,
      });
    });

    it("should add generic secret if no specific type found", async () => {
      // Make sure parseJSONObjectFromText returns null for natural language
      const parseJSON = await import("@elizaos/core").then(
        (m) => m.parseJSONObjectFromText,
      );
      vi.mocked(parseJSON).mockReturnValue(null);

      const message = createTestMemory("Request some information", "user-123");

      await requestSecretFormAction.handler(
        testRuntime,
        message,
        testState,
        {},
        testCallback,
      );

      const formCall = vi.mocked(testFormService.createSecretForm).mock
        .calls[0];
      const request = formCall[0];

      expect(request.secrets[0]).toMatchObject({
        key: "SECRET_VALUE",
        config: {
          type: "secret",
          description: "Secret Information",
        },
      });
    });

    it("should handle submission callback", async () => {
      // Make sure parseJSONObjectFromText returns null for natural language
      const parseJSON = await import("@elizaos/core").then(
        (m) => m.parseJSONObjectFromText,
      );
      vi.mocked(parseJSON).mockReturnValue(null);

      const message = createTestMemory("Request API key", "user-123");

      await requestSecretFormAction.handler(
        testRuntime,
        message,
        testState,
        {},
        testCallback,
      );

      // Verify createSecretForm was called
      expect(testFormService.createSecretForm).toHaveBeenCalled();

      // Get the callback function
      const formCall = vi.mocked(testFormService.createSecretForm).mock
        .calls[0];
      const submissionCallback = formCall[2];

      // Simulate form submission
      const submission = {
        formId: "form-123",
        sessionId: "session-123",
        data: { API_KEY: "test-key" },
        submittedAt: Date.now(),
      };

      // Callback should not throw
      await expect(submissionCallback(submission)).resolves.not.toThrow();
    });
  });

  describe("examples", () => {
    it("should have valid examples", () => {
      expect(requestSecretFormAction.examples).toBeDefined();
      expect(requestSecretFormAction.examples).toHaveLength(3);

      // Check first example
      const firstExample = requestSecretFormAction.examples![0];
      expect(firstExample[0].name).toBe("user");
      expect(firstExample[0].content.text).toBe(
        "I need you to collect my API keys",
      );
      expect(firstExample[1].name).toBe("assistant");
      expect(firstExample[1].content.action).toBe("REQUEST_SECRET_FORM");
    });
  });
});
