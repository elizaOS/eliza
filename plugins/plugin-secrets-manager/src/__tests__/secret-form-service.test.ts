import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SecretFormService } from "../services/secret-form-service";
import { NgrokService } from "../services/ngrok-service";
import { EnhancedSecretManager } from "../enhanced-service";
import type { IAgentRuntime, UUID, Service } from "@elizaos/core";
import type { SecretFormRequest, FormSubmission } from "../types/form";
import type { SecretContext } from "../types";
import express from "express";
import request from "supertest";

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
  };
});

// Mock express and server creation
vi.mock("express");
vi.mock("http", () => ({
  createServer: vi.fn(() => ({
    listen: vi.fn((port, cb) => cb()),
    close: vi.fn((cb) => cb?.()),
  })),
}));

// Mock ngrok so NgrokService does not run the real binary
vi.mock("ngrok", () => ({
  default: {
    connect: vi.fn().mockResolvedValue("https://test.ngrok.io"),
    disconnect: vi.fn(),
    kill: vi.fn(),
    authtoken: vi.fn(),
    getVersion: vi.fn(),
    getApi: vi.fn(),
    getUrl: vi.fn(),
    defaultConfigPath: vi.fn(),
    oldDefaultConfigPath: vi.fn(),
    upgradeConfig: vi.fn(),
  },
}));

// Mock file system imports
vi.mock("url", () => ({
  fileURLToPath: vi.fn(() => "/test/path/file.js"),
}));

vi.mock("path", () => ({
  dirname: vi.fn(() => "/test/path"),
}));

/**
 * Interface for the mock Express app
 */
interface MockExpressApp {
  use: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
}

/**
 * Interface for accessing private members in SecretFormService for testing
 */
interface SecretFormServiceTestable extends SecretFormService {
  ngrokService: NgrokService;
  secretsManager: EnhancedSecretManager;
  cleanupExpiredSessions(): Promise<void>;
}

describe("SecretFormService", () => {
  let formService: SecretFormService;
  let testRuntime: IAgentRuntime;
  let testNgrokService: NgrokService;
  let testSecretsManager: EnhancedSecretManager;
  let mockApp: MockExpressApp;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock Express app
    mockApp = {
      use: vi.fn(),
      get: vi.fn(),
      post: vi.fn(),
    };
    vi.mocked(express).mockReturnValue(mockApp as unknown as express.Express);

    // Create a minimal runtime first (for service constructors)
    const minimalRuntime = {
      agentId: "agent-123" as UUID,
      getSetting: vi.fn().mockReturnValue(null),
      getService: vi.fn().mockReturnValue(null),
    } as unknown as IAgentRuntime;

    // Create test services with minimal runtime
    testNgrokService = new NgrokService(minimalRuntime);
    testSecretsManager = new EnhancedSecretManager(minimalRuntime);

    // Create test runtime with proper service resolution
    testRuntime = {
      agentId: "agent-123" as UUID,
      getSetting: vi.fn().mockReturnValue(null),
      getService: vi.fn(<T extends Service>(name: string): T | null => {
        if (name === "NGROK") return testNgrokService as unknown as T;
        if (name === "SECRETS") return testSecretsManager as unknown as T;
        return null;
      }),
    } as unknown as IAgentRuntime;

    formService = new SecretFormService(testRuntime);

    // Manually set the services after instantiation via the testable interface
    const testable = formService as unknown as SecretFormServiceTestable;
    testable.ngrokService = testNgrokService;
    testable.secretsManager = testSecretsManager;
  });

  afterEach(() => {
    // Clear any intervals
    vi.clearAllTimers();
  });

  describe("start", () => {
    it("should initialize with required services", async () => {
      await formService.start();

      expect(testRuntime.getService).toHaveBeenCalledWith("NGROK");
      expect(testRuntime.getService).toHaveBeenCalledWith("SECRETS");
    });

    it("should throw if NgrokService is not available", async () => {
      testRuntime.getService = vi.fn((type: string) => {
        if (type === "NGROK") return null;
        return testSecretsManager;
      });

      await expect(formService.start()).rejects.toThrow(
        "NgrokService is required",
      );
    });

    it("should throw if SecretManager is not available", async () => {
      testRuntime.getService = vi.fn((type: string) => {
        if (type === "SECRETS") return null;
        return testNgrokService;
      });

      await expect(formService.start()).rejects.toThrow(
        "EnhancedSecretManager is required",
      );
    });

    it("should start cleanup interval", async () => {
      const setIntervalSpy = vi.spyOn(global, "setInterval");

      await formService.start();

      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        60 * 1000,
      );
    });
  });

  describe("createSecretForm", () => {
    beforeEach(async () => {
      await formService.start();
    });

    it("should create a basic secret form", async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: "API_KEY",
            config: {
              type: "api_key",
              description: "Test API Key",
              required: true,
            },
          },
        ],
        title: "Test Form",
      };

      const context: SecretContext = {
        level: "user",
        userId: "user-123",
        agentId: "agent-123",
      };

      const result = await formService.createSecretForm(request, context);

      expect(result).toEqual({
        url: expect.stringMatching(/^https:\/\/test\.ngrok\.io\/form\/.+$/),
        sessionId: expect.any(String),
      });

      expect(testNgrokService.createTunnel).toHaveBeenCalledWith(
        expect.any(Number),
        expect.stringContaining("secret-form-"),
        undefined,
      );
    });

    it("should handle custom expiration time", async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: "API_KEY",
            config: { type: "api_key" },
          },
        ],
        expiresIn: 60 * 60 * 1000, // 1 hour
      };

      const context: SecretContext = {
        level: "global",
        agentId: "agent-123",
      };

      await formService.createSecretForm(request, context);

      expect(testNgrokService.createTunnel).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(String),
        60 * 60 * 1000,
      );
    });

    it("should setup routes correctly", async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: "SECRET",
            config: { type: "secret" },
          },
        ],
      };

      const context: SecretContext = {
        level: "user",
        userId: "user-123",
        agentId: "agent-123",
      };

      const { sessionId } = await formService.createSecretForm(
        request,
        context,
      );

      expect(mockApp.get).toHaveBeenCalledWith(
        `/form/${sessionId}`,
        expect.any(Function),
      );

      expect(mockApp.post).toHaveBeenCalledWith(
        `/api/form/${sessionId}/submit`,
        expect.any(Function),
      );

      expect(mockApp.get).toHaveBeenCalledWith(
        `/api/form/${sessionId}/status`,
        expect.any(Function),
      );
    });

    it("should handle form submission callback", async () => {
      const mockCallback = vi.fn();
      const request: SecretFormRequest = {
        secrets: [
          {
            key: "API_KEY",
            config: { type: "api_key" },
          },
        ],
      };

      const context: SecretContext = {
        level: "user",
        userId: "user-123",
        agentId: "agent-123",
      };

      const { sessionId } = await formService.createSecretForm(
        request,
        context,
        mockCallback,
      );

      // Get the session to verify callback was stored
      const session = formService.getSession(sessionId);
      expect(session?.callback).toBe(mockCallback);
    });

    it("should handle errors gracefully", async () => {
      testNgrokService.createTunnel = vi
        .fn()
        .mockRejectedValue(new Error("Tunnel failed"));

      const request: SecretFormRequest = {
        secrets: [
          {
            key: "API_KEY",
            config: { type: "api_key" },
          },
        ],
      };

      const context: SecretContext = {
        level: "user",
        userId: "user-123",
        agentId: "agent-123",
      };

      await expect(
        formService.createSecretForm(request, context),
      ).rejects.toThrow("Tunnel failed");
    });
  });

  describe("form schema generation", () => {
    beforeEach(async () => {
      await formService.start();
    });

    it("should generate correct schema for multiple secrets", async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: "API_KEY",
            config: {
              type: "api_key",
              description: "API Key",
              required: true,
            },
          },
          {
            key: "WEBHOOK_URL",
            config: {
              type: "url",
              description: "Webhook URL",
              required: false,
            },
          },
        ],
        title: "Multi Secret Form",
        description: "Test description",
        mode: "inline",
      };

      const context: SecretContext = {
        level: "user",
        userId: "user-123",
        agentId: "agent-123",
      };

      const { sessionId } = await formService.createSecretForm(
        request,
        context,
      );
      const session = formService.getSession(sessionId);

      expect(session?.schema).toMatchObject({
        title: "Multi Secret Form",
        description: "Test description",
        mode: "inline",
        fields: expect.arrayContaining([
          expect.objectContaining({
            name: "API_KEY",
            type: "password",
            required: true,
          }),
          expect.objectContaining({
            name: "WEBHOOK_URL",
            type: "url",
            required: false,
          }),
        ]),
      });
    });

    it("should apply field overrides", async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: "CUSTOM_SECRET",
            config: {
              type: "secret",
            },
            field: {
              type: "textarea",
              rows: 10,
              placeholder: "Custom placeholder",
            },
          },
        ],
      };

      const context: SecretContext = {
        level: "user",
        userId: "user-123",
        agentId: "agent-123",
      };

      const { sessionId } = await formService.createSecretForm(
        request,
        context,
      );
      const session = formService.getSession(sessionId);

      expect(session?.schema.fields[0]).toMatchObject({
        type: "textarea",
        rows: 10,
        placeholder: "Custom placeholder",
      });
    });
  });

  describe("form HTML generation", () => {
    beforeEach(async () => {
      await formService.start();
    });

    it("should generate valid HTML with correct fields", async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: "API_KEY",
            config: {
              type: "api_key",
              description: "Your API Key",
            },
          },
        ],
        title: "API Configuration",
        description: "Please enter your API key",
      };

      const context: SecretContext = {
        level: "user",
        userId: "user-123",
        agentId: "agent-123",
      };

      const { sessionId } = await formService.createSecretForm(
        request,
        context,
      );

      // Simulate GET request to form endpoint
      let formHandler: any;
      const getCall = mockApp.get.mock.calls.find(
        (call) => call[0] === `/form/${sessionId}`,
      );
      if (getCall) {
        formHandler = getCall[1];
      }

      const mockReq = {};
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      };

      formHandler(mockReq, mockRes);

      const html = mockRes.send.mock.calls[0][0];
      expect(html).toContain("API Configuration");
      expect(html).toContain("Please enter your API key");
      expect(html).toContain('id="API_KEY"');
      expect(html).toContain('type="password"');
    });

    it("should handle expired forms", async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: "API_KEY",
            config: { type: "api_key" },
          },
        ],
        expiresIn: 100, // Very short
      };

      const context: SecretContext = {
        level: "user",
        userId: "user-123",
        agentId: "agent-123",
      };

      const { sessionId } = await formService.createSecretForm(
        request,
        context,
      );

      // Mark session as expired
      const session = formService.getSession(sessionId);
      if (session) {
        session.status = "expired";
      }

      // Get form handler
      let formHandler: any;
      const getCall = mockApp.get.mock.calls.find(
        (call) => call[0] === `/form/${sessionId}`,
      );
      if (getCall) {
        formHandler = getCall[1];
      }

      const mockReq = {};
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      };

      formHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(410);
      expect(mockRes.send).toHaveBeenCalledWith(
        "This form has expired or been completed.",
      );
    });
  });

  describe("form submission handling", () => {
    beforeEach(async () => {
      await formService.start();
    });

    it("should handle valid submission", async () => {
      const mockCallback = vi.fn();
      const request: SecretFormRequest = {
        secrets: [
          {
            key: "API_KEY",
            config: {
              type: "api_key",
              required: true,
            },
          },
        ],
      };

      const context: SecretContext = {
        level: "user",
        userId: "user-123",
        agentId: "agent-123",
      };

      const { sessionId } = await formService.createSecretForm(
        request,
        context,
        mockCallback,
      );

      // Get submit handler
      let submitHandler: any;
      const postCall = mockApp.post.mock.calls.find(
        (call) => call[0] === `/api/form/${sessionId}/submit`,
      );
      if (postCall) {
        submitHandler = postCall[1];
      }

      const mockReq = {
        body: { API_KEY: "test-api-key-123" },
        ip: "127.0.0.1",
        get: vi.fn(() => "Mozilla/5.0"),
      };
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      };

      await submitHandler(mockReq, mockRes);

      expect(testSecretsManager.set).toHaveBeenCalledWith(
        "API_KEY",
        "test-api-key-123",
        context,
        expect.any(Object),
      );

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { API_KEY: "test-api-key-123" },
          ipAddress: "127.0.0.1",
        }),
      );

      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        message: expect.any(String),
      });
    });

    it("should validate required fields", async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: "API_KEY",
            config: {
              type: "api_key",
              required: true,
            },
          },
        ],
      };

      const context: SecretContext = {
        level: "user",
        userId: "user-123",
        agentId: "agent-123",
      };

      const { sessionId } = await formService.createSecretForm(
        request,
        context,
      );

      // Get submit handler
      let submitHandler: any;
      const postCall = mockApp.post.mock.calls.find(
        (call) => call[0] === `/api/form/${sessionId}/submit`,
      );
      if (postCall) {
        submitHandler = postCall[1];
      }

      const mockReq = {
        body: {}, // Missing required field
        ip: "127.0.0.1",
        get: vi.fn(),
      };
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      };

      await submitHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        errors: expect.objectContaining({
          API_KEY: expect.any(String),
        }),
      });
    });

    it("should close session after max submissions", async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: "API_KEY",
            config: { type: "api_key" },
          },
        ],
        maxSubmissions: 1,
      };

      const context: SecretContext = {
        level: "user",
        userId: "user-123",
        agentId: "agent-123",
      };

      const { sessionId } = await formService.createSecretForm(
        request,
        context,
      );

      // Get submit handler
      let submitHandler: any;
      const postCall = mockApp.post.mock.calls.find(
        (call) => call[0] === `/api/form/${sessionId}/submit`,
      );
      if (postCall) {
        submitHandler = postCall[1];
      }

      const mockReq = {
        body: { API_KEY: "test-key" },
        ip: "127.0.0.1",
        get: vi.fn(),
      };
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      };

      await submitHandler(mockReq, mockRes);

      // Session should be marked as completed
      const session = formService.getSession(sessionId);
      expect(session?.status).toBe("completed");
    });
  });

  describe("session management", () => {
    beforeEach(async () => {
      await formService.start();
    });

    it("should track multiple sessions", async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: "API_KEY",
            config: { type: "api_key" },
          },
        ],
      };

      const context: SecretContext = {
        level: "user",
        userId: "user-123",
        agentId: "agent-123",
      };

      const session1 = await formService.createSecretForm(request, context);
      const session2 = await formService.createSecretForm(request, context);

      expect(formService.getSession(session1.sessionId)).toBeTruthy();
      expect(formService.getSession(session2.sessionId)).toBeTruthy();
      expect(session1.sessionId).not.toBe(session2.sessionId);
    });

    it("should close session properly", async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: "API_KEY",
            config: { type: "api_key" },
          },
        ],
      };

      const context: SecretContext = {
        level: "user",
        userId: "user-123",
        agentId: "agent-123",
      };

      const { sessionId } = await formService.createSecretForm(
        request,
        context,
      );
      const session = formService.getSession(sessionId);

      await formService.closeSession(sessionId);

      expect(testNgrokService.closeTunnel).toHaveBeenCalledWith(
        session?.tunnelId,
      );
      expect(formService.getSession(sessionId)).toBeNull();
    });

    it("should handle cleanup of expired sessions", async () => {
      vi.useFakeTimers();

      const request: SecretFormRequest = {
        secrets: [
          {
            key: "API_KEY",
            config: { type: "api_key" },
          },
        ],
        expiresIn: 1000, // 1 second
      };

      const context: SecretContext = {
        level: "user",
        userId: "user-123",
        agentId: "agent-123",
      };

      const { sessionId } = await formService.createSecretForm(
        request,
        context,
      );

      // Advance time past expiration
      vi.advanceTimersByTime(2000);

      // Manually trigger cleanup (normally done by interval)
      const testable = formService as unknown as SecretFormServiceTestable;
      await testable.cleanupExpiredSessions();

      expect(formService.getSession(sessionId)).toBeNull();

      vi.useRealTimers();
    });
  });

  describe("stop", () => {
    beforeEach(async () => {
      await formService.start();
    });

    it("should close all sessions on stop", async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: "API_KEY",
            config: { type: "api_key" },
          },
        ],
      };

      const context: SecretContext = {
        level: "user",
        userId: "user-123",
        agentId: "agent-123",
      };

      const session1 = await formService.createSecretForm(request, context);
      const session2 = await formService.createSecretForm(request, context);

      await formService.stop();

      expect(formService.getSession(session1.sessionId)).toBeNull();
      expect(formService.getSession(session2.sessionId)).toBeNull();
      expect(testNgrokService.closeTunnel).toHaveBeenCalledTimes(2);
    });
  });

  describe("security", () => {
    beforeEach(async () => {
      await formService.start();
    });

    it("should sanitize HTML in form generation", async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: "API_KEY",
            config: {
              type: "api_key",
              description: '<script>alert("XSS")</script>',
            },
          },
        ],
        title: '<img src=x onerror=alert("XSS")>',
        description: '"><script>alert("XSS")</script>',
      };

      const context: SecretContext = {
        level: "user",
        userId: "user-123",
        agentId: "agent-123",
      };

      const { sessionId } = await formService.createSecretForm(
        request,
        context,
      );

      // Get form handler and generate HTML
      let formHandler: any;
      const getCall = mockApp.get.mock.calls.find(
        (call) => call[0] === `/form/${sessionId}`,
      );
      if (getCall) {
        formHandler = getCall[1];
      }

      const mockReq = {};
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      };

      formHandler(mockReq, mockRes);

      const html = mockRes.send.mock.calls[0][0];

      // HTML should be escaped
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain('<script>alert("XSS")</script>');
    });
  });
});
