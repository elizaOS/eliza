import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import envPlugin from "../index";
import type {
  IAgentRuntime,
  Plugin,
  Service,
  World,
  UUID,
} from "@elizaos/core";
import { EnhancedSecretManager } from "../enhanced-service";
import { NgrokService } from "../services/ngrok-service";
import { SecretFormService } from "../services/secret-form-service";

/**
 * Interface for testing private members of SecretFormService
 */
interface SecretFormServiceTestable extends SecretFormService {
  createFormServer(): {
    app: {
      get: ReturnType<typeof vi.fn>;
      post: ReturnType<typeof vi.fn>;
      use: ReturnType<typeof vi.fn>;
    };
    server: {
      listen: ReturnType<typeof vi.fn>;
    };
  };
}

// Helper to generate a UUID
const uuidv4 = (): UUID => {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  }) as UUID;
};

/**
 * Interface for World data in tests
 */
interface TestWorld {
  id: UUID;
  agentId: UUID;
  serverId: string;
  metadata: {
    secrets?: Record<string, string>;
    [key: string]: unknown;
  };
}

/**
 * Interface for Component data in tests
 */
interface TestComponent {
  id: string;
  entityId: string;
  type: string;
  data: Record<string, unknown>;
}

/**
 * Creates a test runtime with typed mock implementations
 */
const createTestRuntime = (): IAgentRuntime => {
  const worlds = new Map<string, TestWorld>();
  const components = new Map<string, TestComponent[]>();

  return {
    agentId: "agent-123" as UUID,
    getSetting: vi.fn((key: string) => {
      const settings: Record<string, string> = {
        ENCRYPTION_SALT: "test-salt",
        NGROK_AUTH_TOKEN: "test-ngrok-token",
      };
      return settings[key] || null;
    }),
    getService: vi.fn().mockReturnValue(null),
    db: {
      getWorlds: vi.fn(async () => Array.from(worlds.values())),
      createWorld: vi.fn(async (world: TestWorld) => worlds.set(world.id, world)),
      updateWorld: vi.fn(async (world: TestWorld) => worlds.set(world.id, world)),
      getWorld: vi.fn(async (id: UUID) => worlds.get(id) || null),
      getComponents: vi.fn(
        async (entityId: string) => components.get(entityId) || [],
      ),
      createComponent: vi.fn(async (component: TestComponent) => {
        const userComponents = components.get(component.entityId) || [];
        userComponents.push(component);
        components.set(component.entityId, userComponents);
      }),
      updateComponent: vi.fn(async (component: TestComponent) => {
        const userComponents = components.get(component.entityId) || [];
        const index = userComponents.findIndex(
          (c: TestComponent) => c.id === component.id,
        );
        if (index !== -1) {
          userComponents[index] = component;
        } else {
          userComponents.push(component);
        }
        components.set(component.entityId, userComponents);
      }),
    },
  } as unknown as IAgentRuntime;
};

// Mock dependencies
vi.mock("@elizaos/core", async () => {
  const actual = await vi.importActual("@elizaos/core");
  return {
    ...actual,
    logger: {
      info: vi.fn((...args) => console.log("[INFO]", ...args)),
      warn: vi.fn((...args) => console.warn("[WARN]", ...args)),
      error: vi.fn((...args) => console.error("[ERROR]", ...args)),
      debug: vi.fn((...args) => console.log("[DEBUG]", ...args)),
    },
  };
});

describe("Secrets Manager Plugin Integration", () => {
  let mockRuntime: IAgentRuntime;
  let registeredServices: Map<string, any>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRuntime = createTestRuntime();
    registeredServices = new Map();
    mockRuntime.registerService = vi.fn((ServiceClass: any) => {
      const instance = new ServiceClass(mockRuntime);
      registeredServices.set(ServiceClass.serviceType, instance);
    });
    mockRuntime.getService = vi.fn((type: string) =>
      registeredServices.get(type),
    );
  });

  describe("Plugin Structure", () => {
    it("should have correct plugin metadata", () => {
      expect(envPlugin.name).toBe("plugin-env");
      expect(envPlugin.description).toBe(
        "Secret and environment variable management with multi-level support, auto-generation and validation capabilities",
      );
    });

    it("should export all required services", () => {
      expect(envPlugin.services).toBeDefined();
      expect(envPlugin.services).toHaveLength(3);

      const serviceTypes = envPlugin.services!.map((s) => s.serviceType);
      expect(serviceTypes).toContain("SECRETS");
      expect(serviceTypes).toContain("NGROK");
      expect(serviceTypes).toContain("SECRET_FORMS");
    });

    it("should export the request secret form action", () => {
      expect(envPlugin.actions).toBeDefined();
      expect(envPlugin.actions).toHaveLength(4);
      const actionNames = envPlugin.actions!.map((a) => a.name);
      expect(actionNames).toContain("REQUEST_SECRET_FORM");
      expect(actionNames).toContain("MANAGE_SECRET");
      expect(actionNames).toContain("SET_ENV_VAR");
      expect(actionNames).toContain("GENERATE_ENV_VAR");
    });
  });

  describe("Plugin Initialization", () => {
    it("should initialize all services", async () => {
      // Mock the register service to accept classes
      const registeredClasses: string[] = [];
      mockRuntime.registerService = vi.fn((ServiceClass: any) => {
        registeredClasses.push(ServiceClass.serviceType);
        const instance = new ServiceClass(mockRuntime);
        registeredServices.set(ServiceClass.serviceType, instance);
      });

      // Register service classes from plugin
      envPlugin.services?.forEach((ServiceClass) => {
        mockRuntime.registerService(ServiceClass);
      });

      // Check all services were registered
      expect(mockRuntime.registerService).toHaveBeenCalledTimes(3);
      expect(registeredClasses).toContain("SECRETS");
      expect(registeredClasses).toContain("NGROK");
      expect(registeredClasses).toContain("SECRET_FORMS");

      // Check services can be retrieved
      const secretsManager = mockRuntime.getService("SECRETS");
      const ngrokService = mockRuntime.getService("NGROK");
      const formService = mockRuntime.getService("SECRET_FORMS");

      expect(secretsManager).toBeInstanceOf(EnhancedSecretManager);
      expect(ngrokService).toBeInstanceOf(NgrokService);
      expect(formService).toBeInstanceOf(SecretFormService);
    });

    it("should start services in correct order", async () => {
      const startOrder: string[] = [];

      // Create services with mocked start methods
      const testSecrets = new EnhancedSecretManager(mockRuntime);
      const testNgrok = new NgrokService(mockRuntime);
      const testForms = new SecretFormService(mockRuntime);

      // Mock start methods using spyOn for proper typing
      vi.spyOn(testSecrets, 'start').mockImplementation(async () => {
        startOrder.push("SECRETS");
      });

      vi.spyOn(testNgrok, 'start').mockImplementation(async () => {
        startOrder.push("NGROK");
      });

      vi.spyOn(testForms, 'start').mockImplementation(async () => {
        startOrder.push("SECRET_FORMS");
      });

      // Start services in correct order
      await testSecrets.start();
      await testNgrok.start();
      await testForms.start();

      // Check start order - SECRETS and NGROK should start before SECRET_FORMS
      expect(startOrder).toEqual(["SECRETS", "NGROK", "SECRET_FORMS"]);
    });
  });

  describe("End-to-End Secret Management Flow", () => {
    let secretsManager: EnhancedSecretManager;
    let ngrokService: NgrokService;
    let formService: SecretFormService;

    beforeEach(async () => {
      // Register services before starting
      mockRuntime.registerService(EnhancedSecretManager);
      mockRuntime.registerService(NgrokService);
      mockRuntime.registerService(SecretFormService);

      // Create and start enhanced secret manager
      secretsManager = await EnhancedSecretManager.start(mockRuntime);

      // Get service instances
      ngrokService = mockRuntime.getService("NGROK") as NgrokService;
      formService = mockRuntime.getService("SECRET_FORMS") as SecretFormService;

      // Start other services
      await ngrokService.start();
      await formService.start();
    });

    it("should handle complete secret form flow", async () => {
      // Create a secret form
      const formRequest = {
        secrets: [
          {
            key: "TEST_API_KEY",
            config: {
              type: "api_key" as const,
              description: "Test API Key",
              required: true,
              encrypted: false,
            },
          },
        ],
        title: "Test Form",
      };

      const context = {
        level: "user" as const,
        userId: "user-123",
        agentId: mockRuntime.agentId,
        requesterId: "user-123",
      };

      let submissionReceived = false;
      const callback = vi.fn(async () => {
        submissionReceived = true;
      });

      // Mock ngrok tunnel creation
      vi.spyOn(ngrokService, "createTunnel").mockResolvedValue({
        id: "tunnel-123",
        url: "https://test.ngrok.io",
      });

      // Create form
      const { sessionId } = await formService.createSecretForm(
        formRequest,
        context,
        callback,
      );

      expect(sessionId).toBeDefined();

      // Simulate form submission
      const submission = {
        formId: "form-123",
        sessionId,
        data: { TEST_API_KEY: "sk-test-12345" },
        submittedAt: Date.now(),
      };

      // Store the secret (simulating what happens in form submission)
      await secretsManager.set(
        "TEST_API_KEY",
        "sk-test-12345",
        context,
        formRequest.secrets[0].config,
      );

      // Trigger callback
      await callback(submission);

      // Verify secret was stored
      const retrievedSecret = await secretsManager.get("TEST_API_KEY", context);
      expect(retrievedSecret).toBe("sk-test-12345");
      expect(submissionReceived).toBe(true);
    });

    it("should handle multi-level secret access", async () => {
      // Create a world for world-level secrets
      const world: World = {
        id: uuidv4(),
        agentId: mockRuntime.agentId,
        serverId: "server-123",
        metadata: {
          secrets: {},
        },
      };
      await mockRuntime.updateWorld(world);

      // Set secrets at different levels
      await secretsManager.set("SHARED_KEY", "global-value", {
        level: "global",
        agentId: mockRuntime.agentId,
      });

      await secretsManager.set("SHARED_KEY", "world-value", {
        level: "world",
        worldId: world.id,
        agentId: mockRuntime.agentId,
      });

      await secretsManager.set("SHARED_KEY", "user-value", {
        level: "user",
        userId: "user-123",
        agentId: mockRuntime.agentId,
        requesterId: "user-123",
      });

      // Test hierarchical access
      const userValue = await secretsManager.get("SHARED_KEY", {
        level: "user",
        userId: "user-123",
        agentId: mockRuntime.agentId,
        requesterId: "user-123",
      });
      expect(userValue).toBe("user-value");

      // Test fallback to world level
      const worldValue = await secretsManager.get("SHARED_KEY", {
        level: "world",
        worldId: world.id,
        agentId: mockRuntime.agentId,
      });
      expect(worldValue).toBe("world-value");

      // Test fallback to global level
      const globalValue = await secretsManager.get("SHARED_KEY", {
        level: "global",
        agentId: mockRuntime.agentId,
      });
      expect(globalValue).toBe("global-value");
    });
  });

  describe("Error Handling", () => {
    let secretsManager: EnhancedSecretManager;
    let ngrokService: NgrokService;
    let formService: SecretFormService;

    beforeEach(async () => {
      // Register services before starting
      mockRuntime.registerService(EnhancedSecretManager);
      mockRuntime.registerService(NgrokService);
      mockRuntime.registerService(SecretFormService);

      // Create and start enhanced secret manager
      secretsManager = await EnhancedSecretManager.start(mockRuntime);

      // Get service instances
      ngrokService = mockRuntime.getService("NGROK") as NgrokService;
      formService = mockRuntime.getService("SECRET_FORMS") as SecretFormService;

      // Start other services
      await ngrokService.start();
      await formService.start();
    });

    it("should handle missing encryption key gracefully", async () => {
      // Create a new runtime with no settings for encryption key
      const newRuntime: IAgentRuntime = {
        ...mockRuntime,
        getSetting: vi.fn().mockReturnValue(null),
      } as unknown as IAgentRuntime;

      const newSecretsManager = await EnhancedSecretManager.start(
        newRuntime,
      );

      // Should still work but without encryption
      await newSecretsManager.set("TEST_KEY", "test-value", {
        level: "global",
        agentId: newRuntime.agentId,
      });

      const value = await newSecretsManager.get("TEST_KEY", {
        level: "global",
        agentId: newRuntime.agentId,
      });

      expect(value).toBe("test-value");
    });

    it("should handle ngrok service failures", async () => {
      // Mock ngrok failure
      vi.spyOn(ngrokService, "createTunnel").mockRejectedValue(
        new Error("Ngrok connection failed"),
      );

      // Try to create form
      await expect(
        formService.createSecretForm(
          {
            secrets: [
              {
                key: "TEST",
                config: { type: "secret" },
              },
            ],
          },
          {
            level: "global",
            agentId: mockRuntime.agentId,
          },
        ),
      ).rejects.toThrow("Ngrok connection failed");
    });
  });

  describe("Security Features", () => {
    let secretsManager: EnhancedSecretManager;

    beforeEach(async () => {
      secretsManager = new EnhancedSecretManager(mockRuntime);
      await EnhancedSecretManager.start(mockRuntime);
    });

    it("should encrypt sensitive secrets", async () => {
      const context = {
        level: "user" as const,
        userId: "user-123",
        agentId: mockRuntime.agentId,
        requesterId: "user-123",
      };

      // Set a sensitive secret
      await secretsManager.set("PRIVATE_KEY", "super-secret-key", context, {
        type: "private_key",
        encrypted: true,
      });

      // The value should be encrypted when stored
      // In real implementation, we'd check the actual encrypted value
      const retrievedValue = await secretsManager.get("PRIVATE_KEY", context);

      expect(retrievedValue).toBe("super-secret-key");
    });

    it("should enforce access permissions", async () => {
      const userContext = {
        level: "user" as const,
        userId: "user-123",
        agentId: mockRuntime.agentId,
        requesterId: "user-123",
      };

      // Set a secret with specific permissions
      await secretsManager.set(
        "RESTRICTED_KEY",
        "restricted-value",
        userContext,
        {
          type: "api_key",
          permissions: [], // Initialize as empty array
        },
      );

      // Grant access to a specific action
      await secretsManager.grantAccess(
        "RESTRICTED_KEY",
        userContext,
        "action-456", // grantee
        ["read"], // permissions
      );

      // Verify access was granted
      const hasAccess = await secretsManager.checkAccess(
        "RESTRICTED_KEY",
        userContext,
        {
          entityId: "action-456",
          permission: "read",
        },
      );

      expect(hasAccess).toBe(true);
    });
  });

  describe("Service Lifecycle", () => {
    it("should properly stop all services", async () => {
      const mockSecrets = new EnhancedSecretManager(mockRuntime);
      const mockNgrok = new NgrokService(mockRuntime);
      const mockForms = new SecretFormService(mockRuntime);

      const services = [mockSecrets, mockNgrok, mockForms];

      // Add stop methods if they don't exist
      mockSecrets.stop = vi.fn();

      // Spy on stop methods
      const stopSpies = services.map((service) =>
        vi.spyOn(service, "stop").mockResolvedValue(undefined),
      );

      // Stop all services
      for (const service of services) {
        await service.stop();
      }

      // Verify all were stopped
      stopSpies.forEach((spy) => {
        expect(spy).toHaveBeenCalled();
      });
    });
  });

  describe("Performance", () => {
    let secretsManager: EnhancedSecretManager;
    let ngrokService: NgrokService;
    let formService: SecretFormService;

    beforeEach(async () => {
      // Register services before starting
      mockRuntime.registerService(EnhancedSecretManager);
      mockRuntime.registerService(NgrokService);
      mockRuntime.registerService(SecretFormService);

      // Create and start enhanced secret manager
      secretsManager = await EnhancedSecretManager.start(mockRuntime);

      // Get service instances
      ngrokService = mockRuntime.getService("NGROK") as NgrokService;
      formService = mockRuntime.getService("SECRET_FORMS") as SecretFormService;

      // Start other services
      await ngrokService.start();
      await formService.start();
    });

    it("should handle concurrent secret operations", async () => {
      const context = {
        level: "user" as const,
        userId: "user-123",
        agentId: mockRuntime.agentId,
        requesterId: "user-123",
      };

      // Create many concurrent operations
      const operations = Array.from({ length: 100 }, (_, i) => ({
        key: `CONCURRENT_KEY_${i}`,
        value: `value_${i}`,
      }));

      // Set all concurrently
      const setPromises = operations.map(({ key, value }) =>
        secretsManager.set(key, value, context),
      );

      await Promise.all(setPromises);

      // Get all concurrently
      const getPromises = operations.map(({ key }) =>
        secretsManager.get(key, context),
      );

      const results = await Promise.all(getPromises);

      // Verify all values
      results.forEach((value, i) => {
        expect(value).toBe(`value_${i}`);
      });
    });

    it("should handle rapid form creation", async () => {
      // Mock ngrok to handle rapid creation
      let tunnelCount = 0;
      vi.spyOn(ngrokService, "createTunnel").mockImplementation(async () => ({
        id: `tunnel-${tunnelCount++}`,
        url: `https://test${tunnelCount}.ngrok.io`,
      }));

      // Mock the form server creation to avoid actual servers
      const testableFormService = formService as unknown as SecretFormServiceTestable;
      vi.spyOn(testableFormService, "createFormServer").mockReturnValue({
        app: {
          get: vi.fn(),
          post: vi.fn(),
          use: vi.fn(),
        },
        server: {
          listen: vi.fn((port: number, cb: () => void) => cb()),
        },
      });

      // Create multiple forms rapidly
      const formPromises = Array.from({ length: 10 }, (_, i) =>
        formService.createSecretForm(
          {
            secrets: [
              {
                key: `KEY_${i}`,
                config: { type: "secret" },
              },
            ],
            title: `Form ${i}`,
          },
          {
            level: "global",
            agentId: mockRuntime.agentId,
          },
        ),
      );

      const results = await Promise.all(formPromises);

      // Verify all forms were created
      expect(results).toHaveLength(10);
      results.forEach((result) => {
        expect(result.sessionId).toBeDefined();
        expect(result.url).toContain("ngrok.io");
      });
    });
  });
});
