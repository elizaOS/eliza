import { describe, it, expect, beforeEach, vi } from "vitest";
import { type IAgentRuntime } from "@elizaos/core";
import { EnvManagerService } from "./service";
import { Character, Plugin, World, Service, UUID } from "@elizaos/core";
import { canGenerateEnvVar } from "./generation";
import type { EnvVarConfig, PluginEnvVars } from "./types";

/**
 * Interface for accessing private members of EnvManagerService in tests
 */
interface EnvManagerServiceTestable extends EnvManagerService {
  envVarCache: Record<string, PluginEnvVars> | null;
  runtime: IAgentRuntime | null;
  loadEnvVarsFromSecrets(): Promise<void>;
  scanCharacterSecrets(): Promise<void>;
  scanLoadedPlugins(): Promise<void>;
  saveEnvVarsToSecrets(): Promise<void>;
}

/**
 * Interface for plugin with declaredEnvVars for testing
 */
interface PluginWithDeclaredEnvVars extends Plugin {
  declaredEnvVars?: Record<string, Partial<EnvVarConfig>>;
}

// Mock @elizaos/core and its logger
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

// Import the mocked logger after the mock is set up
import { logger } from "@elizaos/core";

// Create a mock runtime that matches the actual IAgentRuntime interface
const createMockRuntime = (): IAgentRuntime => {
  const settings = new Map<string, string | null>();
  const services = new Map<string, Service>();

  const mockRuntime = {
    // Properties from IAgentRuntime
    agentId: "test-agent-id" as UUID,
    character: {
      id: "test-character-id" as UUID,
      name: "Test Character",
      bio: "Test bio",
      settings: { secrets: {} },
    } as Character,
    providers: [],
    actions: [],
    evaluators: [],
    plugins: [] as Plugin[],
    services,
    events: new Map(),
    fetch: vi.fn(),
    routes: [],

    // Methods from IAgentRuntime
    registerPlugin: vi.fn(),
    initialize: vi.fn(),
    getConnection: vi.fn(),
    getService: vi.fn((name: string) => services.get(name)),
    getAllServices: vi.fn(),
    registerService: vi.fn((service: Service) => {
      const ctor = service.constructor as { serviceType?: string; name: string };
      services.set(
        ctor.serviceType || ctor.name,
        service,
      );
    }),
    setSetting: vi.fn((key: string, value: string | null) => {
      settings.set(key, value);
    }),
    getSetting: vi.fn((key: string) => settings.get(key)),
    getConversationLength: vi.fn(),
    processActions: vi.fn(),
    evaluate: vi.fn(),
    registerProvider: vi.fn(),
    registerAction: vi.fn(),
    registerEvaluator: vi.fn(),
    ensureConnection: vi.fn(),
    ensureParticipantInRoom: vi.fn(),
    ensureWorldExists: vi.fn(),
    ensureRoomExists: vi.fn(),
    composeState: vi.fn(),
    useModel: vi.fn(),
    registerModel: vi.fn(),
    getModel: vi.fn(),
    registerEvent: vi.fn(),
    getEvent: vi.fn(),
    emitEvent: vi.fn(),
    registerTaskWorker: vi.fn(),
    getTaskWorker: vi.fn(),
    stop: vi.fn(),
    addEmbeddingToMemory: vi.fn(),
    getEntityById: vi.fn(),
    getRoom: vi.fn(),
    createEntity: vi.fn(),
    createRoom: vi.fn(),
    addParticipant: vi.fn(),
    getRooms: vi.fn(),
    registerSendHandler: vi.fn(),
    sendMessageToTarget: vi.fn(),

    // Methods from IDatabaseAdapter (inherited by IAgentRuntime)
    db: {},
    init: vi.fn(),
    close: vi.fn(),
    getAgent: vi.fn(),
    getAgents: vi.fn(),
    createAgent: vi.fn(),
    updateAgent: vi.fn(),
    deleteAgent: vi.fn(),
    ensureAgentExists: vi.fn(),
    ensureEmbeddingDimension: vi.fn(),
    getEntityByIds: vi.fn(),
    getEntitiesForRoom: vi.fn(),
    createEntities: vi.fn(),
    updateEntity: vi.fn(),
    getComponent: vi.fn(),
    getComponents: vi.fn(),
    createComponent: vi.fn(),
    updateComponent: vi.fn(),
    deleteComponent: vi.fn(),
    getMemories: vi.fn(),
    getMemoryById: vi.fn(),
    getMemoriesByIds: vi.fn(),
    getMemoriesByRoomIds: vi.fn(),
    getMemoriesByServerId: vi.fn(),
    getCachedEmbeddings: vi.fn(),
    log: vi.fn(),
    getLogs: vi.fn(),
    deleteLog: vi.fn(),
    searchMemories: vi.fn(),
    createMemory: vi.fn(),
    updateMemory: vi.fn(),
    deleteMemory: vi.fn(),
    deleteAllMemories: vi.fn(),
    countMemories: vi.fn(),
    createWorld: vi.fn(),
    getWorld: vi.fn(),
    removeWorld: vi.fn(),
    getAllWorlds: vi.fn(),
    updateWorld: vi.fn(),
    getRoomsByIds: vi.fn(),
    createRooms: vi.fn(),
    deleteRoom: vi.fn(),
    deleteRoomsByWorldId: vi.fn(),
    updateRoom: vi.fn(),
    getRoomsForParticipant: vi.fn(),
    getRoomsForParticipants: vi.fn(),
    getRoomsByWorld: vi.fn(),
    removeParticipant: vi.fn(),
    getParticipantsForEntity: vi.fn(),
    getParticipantsForRoom: vi.fn(),
    addParticipantsRoom: vi.fn(),
    getParticipantUserState: vi.fn(),
    setParticipantUserState: vi.fn(),
    createRelationship: vi.fn(),
    updateRelationship: vi.fn(),
    getRelationship: vi.fn(),
    getRelationships: vi.fn(),
    getCache: vi.fn(),
    setCache: vi.fn(),
    deleteCache: vi.fn(),
    createTask: vi.fn(),
    getTasks: vi.fn(),
    getTask: vi.fn(),
    getTasksByName: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    getMemoriesByWorldId: vi.fn(),
  } as unknown as IAgentRuntime;

  return mockRuntime;
};

describe("EnvManagerService", () => {
  let envService: EnvManagerService;
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRuntime = createMockRuntime();
    envService = new EnvManagerService(mockRuntime);
  });

  it("should be defined", () => {
    expect(envService).toBeDefined();
  });

  describe("initialize", () => {
    it("should load env vars from secrets and scan plugin requirements", async () => {
      const testable = envService as unknown as EnvManagerServiceTestable;
      const loadSpy = vi.spyOn(testable, "loadEnvVarsFromSecrets");
      const scanSpy = vi.spyOn(envService, "scanPluginRequirements");
      await envService.initialize();
      expect(loadSpy).toHaveBeenCalled();
      expect(scanSpy).toHaveBeenCalled();
    });
  });

  describe("scanPluginRequirements", () => {
    it("should scan character secrets if they exist", async () => {
      mockRuntime.character.settings = {
        secrets: { CHARACTER_API_KEY: "test-key" },
      };

      const testable = envService as unknown as EnvManagerServiceTestable;
      const scanCharacterSecretsSpy = vi.spyOn(
        testable,
        "scanCharacterSecrets",
      );
      const scanLoadedPluginsSpy = vi.spyOn(
        testable,
        "scanLoadedPlugins",
      );
      const saveEnvVarsToSecretsSpy = vi.spyOn(
        testable,
        "saveEnvVarsToSecrets",
      );

      await envService.scanPluginRequirements();

      expect(scanCharacterSecretsSpy).toHaveBeenCalled();
      expect(scanLoadedPluginsSpy).toHaveBeenCalled();
      expect(saveEnvVarsToSecretsSpy).toHaveBeenCalled();
    });

    it("should handle existing env var metadata", async () => {
      const existingMetadata = {
        "existing-plugin": {
          EXISTING_VAR: {
            type: "config",
            required: true,
            description: "Existing variable",
            canGenerate: false,
            status: "valid",
            attempts: 1,
            plugin: "existing-plugin",
            createdAt: Date.now(),
            value: "existing-value",
          },
        },
      };

      mockRuntime.character.settings = {
        secrets: {
          __env_metadata: JSON.stringify(existingMetadata),
          ENV_EXISTING_VAR: "existing-value",
        },
      };

      await envService.initialize();

      const envVars = await envService.getAllEnvVars();
      expect(envVars).toMatchObject(existingMetadata);
      expect(envVars?.character).toBeDefined();
      expect(mockRuntime.getSetting("ENV_EXISTING_VAR")).toBe("existing-value");
    });
  });

  describe("getEnvVarsForPlugin", () => {
    it("should return plugin env vars if they exist", async () => {
      const testVars = {
        TEST_VAR: {
          type: "config" as const,
          required: true,
          description: "Test variable",
          canGenerate: false,
          status: "valid" as const,
          attempts: 0,
          plugin: "test-plugin",
          createdAt: Date.now(),
          value: "test-value",
        },
      };

      (envService as unknown as EnvManagerServiceTestable).envVarCache = {
        "test-plugin": testVars,
      };

      const result = await envService.getEnvVarsForPlugin("test-plugin");
      expect(result).toEqual(testVars);
    });

    it("should return null for non-existent plugin", async () => {
      const result = await envService.getEnvVarsForPlugin("non-existent");
      expect(result).toBeNull();
    });
  });

  describe("updateEnvVar", () => {
    it("should update environment variable and runtime setting", async () => {
      const result = await envService.updateEnvVar("test-plugin", "TEST_VAR", {
        value: "test-value",
        status: "valid" as const,
      });

      expect(result).toBe(true);
      expect(mockRuntime.setSetting).toHaveBeenCalledWith(
        "ENV_TEST_VAR",
        "test-value",
      );

      const envVars = await envService.getAllEnvVars();
      expect(envVars?.["test-plugin"]?.TEST_VAR?.value).toBe("test-value");
    });

    it("should handle duplicate values", async () => {
      // Set initial value
      await envService.updateEnvVar("test-plugin", "TEST_VAR", {
        value: "test-value",
        status: "valid" as const,
      });

      // Try to set same value again
      const result = await envService.updateEnvVar("test-plugin", "TEST_VAR", {
        value: "test-value",
        status: "valid" as const,
      });

      expect(result).toBe(true); // Should return true but not update
      const envVars = await envService.getAllEnvVars();
      expect(envVars?.["test-plugin"]?.TEST_VAR?.attempts).toBe(0); // Attempts should not increase
    });

    it("should save to character secrets", async () => {
      const testable = envService as unknown as EnvManagerServiceTestable;
      const saveSecretsSpy = vi.spyOn(
        testable,
        "saveEnvVarsToSecrets",
      );

      await envService.updateEnvVar("test-plugin", "TEST_VAR", {
        value: "test-value",
        status: "valid" as const,
      });

      expect(saveSecretsSpy).toHaveBeenCalled();
      expect(mockRuntime.character.settings?.secrets?.ENV_TEST_VAR).toBe(
        "test-value",
      );
    });
  });

  describe("getEnvVar", () => {
    it("should get environment variable value from runtime settings", () => {
      mockRuntime.setSetting("ENV_TEST_VAR", "test-value");
      const result = envService.getEnvVar("TEST_VAR");
      expect(result).toBe("test-value");
    });

    it("should return null for non-existent variable", () => {
      const result = envService.getEnvVar("NON_EXISTENT");
      expect(result).toBeNull();
    });
  });

  describe("hasMissingEnvVars", () => {
    it("should return false if no env vars exist", async () => {
      const result = await envService.hasMissingEnvVars();
      expect(result).toBe(false);
    });

    it("should return true if there are missing required env vars", async () => {
      (envService as unknown as EnvManagerServiceTestable).envVarCache = {
        "test-plugin": {
          MISSING_VAR: {
            type: "config" as const,
            required: true,
            description: "Missing variable",
            canGenerate: false,
            status: "missing" as const,
            attempts: 0,
            plugin: "test-plugin",
            createdAt: Date.now(),
          },
        },
      };

      const result = await envService.hasMissingEnvVars();
      expect(result).toBe(true);
    });

    it("should return false if all required env vars are present", async () => {
      (envService as unknown as EnvManagerServiceTestable).envVarCache = {
        "test-plugin": {
          PRESENT_VAR: {
            type: "config" as const,
            required: true,
            description: "Present variable",
            canGenerate: false,
            status: "valid" as const,
            attempts: 0,
            plugin: "test-plugin",
            createdAt: Date.now(),
            value: "present",
          },
          OPTIONAL_MISSING_VAR: {
            type: "config" as const,
            required: false,
            description: "Optional missing variable",
            canGenerate: false,
            status: "missing" as const,
            attempts: 0,
            plugin: "test-plugin",
            createdAt: Date.now(),
          },
        },
      };

      const result = await envService.hasMissingEnvVars();
      expect(result).toBe(false);
    });
  });

  describe("getMissingEnvVars", () => {
    it("should return empty array if no env vars exist", async () => {
      const result = await envService.getMissingEnvVars();
      expect(result).toEqual([]);
    });

    it("should return missing required env vars", async () => {
      (envService as unknown as EnvManagerServiceTestable).envVarCache = {
        "test-plugin": {
          MISSING_VAR: {
            type: "config" as const,
            required: true,
            description: "Missing variable",
            canGenerate: false,
            status: "missing" as const,
            attempts: 0,
            plugin: "test-plugin",
            createdAt: Date.now(),
          },
          PRESENT_VAR: {
            type: "config" as const,
            required: true,
            description: "Present variable",
            canGenerate: false,
            status: "valid" as const,
            attempts: 0,
            plugin: "test-plugin",
            createdAt: Date.now(),
            value: "present",
          },
        },
      };

      const result = await envService.getMissingEnvVars();
      expect(result).toHaveLength(1);
      expect(result[0].varName).toBe("MISSING_VAR");
      expect(result[0].plugin).toBe("test-plugin");
    });
  });

  describe("getGeneratableEnvVars", () => {
    it("should return only missing env vars that can be generated", async () => {
      (envService as unknown as EnvManagerServiceTestable).envVarCache = {
        "test-plugin": {
          GENERATABLE_VAR: {
            type: "secret" as const,
            required: true,
            description: "Generatable variable",
            canGenerate: true,
            status: "missing" as const,
            attempts: 0,
            plugin: "test-plugin",
            createdAt: Date.now(),
          },
          NON_GENERATABLE_VAR: {
            type: "api_key" as const,
            required: true,
            description: "Non-generatable variable",
            canGenerate: false,
            status: "missing" as const,
            attempts: 0,
            plugin: "test-plugin",
            createdAt: Date.now(),
          },
        },
      };

      const result = await envService.getGeneratableEnvVars();
      expect(result).toHaveLength(1);
      expect(result[0].varName).toBe("GENERATABLE_VAR");
      expect(result[0].config.canGenerate).toBe(true);
    });
  });

  describe("stop", () => {
    it("should save env vars to secrets when stopping", async () => {
      const testable = envService as unknown as EnvManagerServiceTestable;
      const saveSecretsSpy = vi.spyOn(
        testable,
        "saveEnvVarsToSecrets",
      );

      await envService.stop();

      expect(saveSecretsSpy).toHaveBeenCalled();
    });
  });
});

describe("EnvManagerService Edge Cases", () => {
  it("should handle errors in getEnvVarsForPlugin", async () => {
    const runtime = createMockRuntime();
    const service = await EnvManagerService.start(runtime);

    // Force an error by mocking the internal cache
    (service as unknown as EnvManagerServiceTestable).envVarCache = null;

    const result = await service.getEnvVarsForPlugin("test-plugin");
    expect(result).toBeNull();
  });

  it("should handle errors in getAllEnvVars", async () => {
    const runtime = createMockRuntime();
    const service = await EnvManagerService.start(runtime);

    // Force an error by mocking the internal cache
    (service as unknown as EnvManagerServiceTestable).envVarCache = null;

    const result = await service.getAllEnvVars();
    expect(result).toBeNull();
  });

  it("should create default config when updating non-existent env var", async () => {
    const runtime = createMockRuntime();
    const service = await EnvManagerService.start(runtime);

    // Update a non-existent env var
    const result = await service.updateEnvVar("new-plugin", "NEW_VAR", {
      value: "test-value",
    });

    expect(result).toBe(true);
    expect(runtime.setSetting).toHaveBeenCalledWith(
      "ENV_NEW_VAR",
      "test-value",
    );

    const vars = await service.getEnvVarsForPlugin("new-plugin");
    expect(vars).toBeDefined();
    expect(vars?.NEW_VAR).toBeDefined();
    expect(vars?.NEW_VAR.type).toBe("config");
    expect(vars?.NEW_VAR.value).toBe("test-value");
  });

  it("should skip duplicate values when updating env var", async () => {
    const runtime = createMockRuntime();
    const service = await EnvManagerService.start(runtime);

    // First update
    await service.updateEnvVar("test-plugin", "TEST_VAR", {
      value: "same-value",
      status: "valid",
    });

    // Clear the setSetting calls
    vi.mocked(runtime.setSetting).mockClear();

    // Try to update with same value
    const result = await service.updateEnvVar("test-plugin", "TEST_VAR", {
      value: "same-value",
    });

    expect(result).toBe(true);
    // setSetting should not have been called again
    expect(runtime.setSetting).not.toHaveBeenCalled();
  });

  it("should handle error when updating env var", async () => {
    const runtime = createMockRuntime();
    const service = await EnvManagerService.start(runtime);

    // Force an error by making setSetting throw
    vi.mocked(runtime.setSetting).mockImplementation(() => {
      throw new Error("Failed to set setting");
    });

    const result = await service.updateEnvVar("test-plugin", "TEST_VAR", {
      value: "test-value",
    });

    expect(result).toBe(false);
  });

  it("should get env var value from runtime settings", async () => {
    const runtime = createMockRuntime();
    const service = await EnvManagerService.start(runtime);

    // Mock getSetting to return a value
    vi.mocked(runtime.getSetting).mockReturnValue("test-value");

    const value = service.getEnvVar("TEST_VAR");
    expect(value).toBe("test-value");
    expect(runtime.getSetting).toHaveBeenCalledWith("ENV_TEST_VAR");
  });

  it("should return null when env var not found", async () => {
    const runtime = createMockRuntime();
    const service = await EnvManagerService.start(runtime);

    // Mock getSetting to return null
    vi.mocked(runtime.getSetting).mockReturnValue(null);

    const value = service.getEnvVar("MISSING_VAR");
    expect(value).toBeNull();
  });

  it("should handle static stop method", async () => {
    const runtime = createMockRuntime();
    const service = await EnvManagerService.start(runtime);

    // Register the service
    vi.mocked(runtime.getService).mockReturnValue(service);

    await EnvManagerService.stop(runtime);

    expect(runtime.getService).toHaveBeenCalledWith("ENV_MANAGER");
  });

  it("should handle static stop method when service not found", async () => {
    const runtime = createMockRuntime();

    // Mock getService to return undefined
    vi.mocked(runtime.getService).mockReturnValue(undefined);

    // This should not throw
    await expect(EnvManagerService.stop(runtime)).resolves.toBeUndefined();
  });
});

describe("Plugin Scanning", () => {
  it("should scan loaded plugins with declaredEnvVars", async () => {
    const runtime = createMockRuntime();
    runtime.plugins = [
      {
        name: "test-plugin",
        description: "Test plugin",
        actions: [],
        providers: [],
        evaluators: [],
        declaredEnvVars: {
          PLUGIN_API_KEY: {
            type: "api_key",
            required: true,
            description: "API key for test plugin",
            canGenerate: false,
          },
          PLUGIN_URL: {
            type: "url",
            required: false,
            description: "URL for test plugin",
            defaultValue: "https://api.example.com",
          },
          PLUGIN_SECRET: {
            // No type specified, should be inferred
            description: "Secret for test plugin",
          },
        },
      } as unknown as PluginWithDeclaredEnvVars,
    ] as Plugin[];

    const service = await EnvManagerService.start(runtime);

    const envVars = await service.getAllEnvVars();
    expect(envVars).toBeDefined();
    expect(envVars["test-plugin"]).toBeDefined();
    expect(envVars["test-plugin"]["PLUGIN_API_KEY"]).toMatchObject({
      type: "api_key",
      required: true,
      description: "API key for test plugin",
      canGenerate: false,
      status: "missing",
    });
    expect(envVars["test-plugin"]["PLUGIN_URL"]).toMatchObject({
      type: "url",
      required: false,
      description: "URL for test plugin",
      status: "valid",
      value: "https://api.example.com",
    });
    expect(envVars["test-plugin"]["PLUGIN_SECRET"]).toMatchObject({
      type: "secret",
      description: "Secret for test plugin",
      status: "missing",
    });
  });

  it("should handle character secrets scanning", async () => {
    const runtime = createMockRuntime();
    runtime.character = {
      name: "TestAgent",
      bio: "Test agent bio",
      settings: {
        secrets: {
          SOME_API_KEY: "test-key",
          PRIVATE_KEY: null,
          __env_metadata: JSON.stringify({}),
        },
      },
    };

    const service = await EnvManagerService.start(runtime);

    const envVars = await service.getAllEnvVars();
    expect(envVars).toBeDefined();
    expect(envVars["character"]).toBeDefined();
    expect(envVars["character"]["SOME_API_KEY"]).toMatchObject({
      type: "api_key",
      required: true,
      status: "valid",
      value: "test-key",
    });
    expect(envVars["character"]["PRIVATE_KEY"]).toMatchObject({
      type: "private_key",
      required: true,
      status: "missing",
    });
  });

  it("should skip self when scanning plugins", async () => {
    const runtime = createMockRuntime();
    runtime.plugins = [
      {
        name: "plugin-env",
        description: "Environment plugin",
        actions: [],
        providers: [],
        evaluators: [],
        declaredEnvVars: {
          SHOULD_NOT_SCAN: {
            type: "config",
          },
        },
      } as unknown as PluginWithDeclaredEnvVars,
    ] as Plugin[];

    const service = await EnvManagerService.start(runtime);

    const envVars = await service.getAllEnvVars();
    expect(envVars["plugin-env"]).toBeUndefined();
  });

  it("should handle plugins without declaredEnvVars", async () => {
    const runtime = createMockRuntime();
    runtime.plugins = [
      {
        name: "test-plugin",
        description: "Test plugin without env vars",
        actions: [],
        providers: [],
        evaluators: [],
        // No declaredEnvVars
      },
    ];

    const service = await EnvManagerService.start(runtime);

    const envVars = await service.getAllEnvVars();
    expect(envVars["test-plugin"]).toBeUndefined();
  });

  it("should handle error when loading from secrets", async () => {
    const runtime = createMockRuntime();
    runtime.character = {
      name: "TestAgent",
      bio: "Test agent bio",
      settings: {
        secrets: {
          __env_metadata: "invalid json",
        },
      },
    };

    const service = await EnvManagerService.start(runtime);

    // Should still initialize with empty cache
    const envVars = await service.getAllEnvVars();
    expect(envVars).toBeDefined();
  });

  it("should handle error when saving to secrets", async () => {
    const runtime = createMockRuntime();
    // Make character read-only to cause error
    Object.defineProperty(runtime, "character", {
      value: {},
      writable: false,
    });

    const service = await EnvManagerService.start(runtime);

    // Should still work despite save error
    const result = await service.updateEnvVar("test", "VAR", {
      value: "test",
    });
    expect(result).toBe(true);
  });
});

describe("EnvManagerService Additional Coverage", () => {
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    vi.clearAllMocks();

    mockRuntime = {
      character: {
        name: "TestAgent",
        settings: {
          secrets: {},
        },
      },
      getSetting: vi.fn(),
      setSetting: vi.fn(),
      getService: vi.fn(),
      plugins: [],
    } as unknown as IAgentRuntime;
  });

  it("should handle character secrets with existing ENV_ prefixed keys", async () => {
    mockRuntime.character.settings.secrets = {
      __env_metadata: JSON.stringify({
        character: {
          TEST_VAR: {
            type: "api_key",
            required: true,
            description: "Test var",
            canGenerate: false,
            status: "valid",
            attempts: 0,
            plugin: "character",
            createdAt: Date.now(),
            value: "existing-value",
            validatedAt: Date.now(),
          },
        },
      }),
      ENV_TEST_VAR: "existing-value",
    };

    const service = await EnvManagerService.start(mockRuntime);
    const envVars = await service.getEnvVarsForPlugin("character");

    expect(envVars).toBeDefined();
    expect(envVars?.TEST_VAR.value).toBe("existing-value");
  });

  it("should skip __env_metadata key when scanning character secrets", async () => {
    mockRuntime.character.settings.secrets = {
      __env_metadata: "{}",
      SOME_VAR: "value",
    };

    const service = await EnvManagerService.start(mockRuntime);
    const envVars = await service.getEnvVarsForPlugin("character");

    expect(envVars).toBeDefined();
    expect(envVars?.SOME_VAR).toBeDefined();
    expect(envVars?.__env_metadata).toBeUndefined();
  });

  it("should handle plugins with declared env vars that have validationMethod", async () => {
    mockRuntime.plugins = [
      {
        name: "test-plugin",
        declaredEnvVars: {
          API_KEY: {
            type: "api_key",
            required: true,
            description: "API Key",
            canGenerate: false,
            validationMethod: "api_key:openai",
          },
        },
      } as unknown as PluginWithDeclaredEnvVars,
    ] as Plugin[];

    const service = await EnvManagerService.start(mockRuntime);
    const envVars = await service.getEnvVarsForPlugin("test-plugin");

    expect(envVars?.API_KEY.validationMethod).toBe("api_key:openai");
  });

  it("should handle getAllEnvVars error", async () => {
    const service = new EnvManagerService();
    // Manually set runtime to null to trigger error
    (service as unknown as EnvManagerServiceTestable).runtime = null;

    const result = await service.getAllEnvVars();

    // Service returns envVarCache which is initialized as empty object
    expect(result).toEqual({});
  });

  it("should handle getEnvVarsForPlugin error", async () => {
    const service = new EnvManagerService();
    // Initialize envVarCache but without the requested plugin
    (service as unknown as EnvManagerServiceTestable).envVarCache = { "other-plugin": {} };

    const result = await service.getEnvVarsForPlugin("test");

    expect(result).toBeNull();
  });

  it("should handle scanPluginRequirements error", async () => {
    // Mock character to throw error
    Object.defineProperty(mockRuntime, "character", {
      get() {
        throw new Error("Test error");
      },
    });

    const service = new EnvManagerService();
    (service as unknown as EnvManagerServiceTestable).runtime = mockRuntime;

    await service.scanPluginRequirements();

    expect(logger.error).toHaveBeenCalledWith(
      "[EnvManager] Error scanning plugin requirements:",
      expect.any(Error),
    );
  });

  it("should handle saveEnvVarsToSecrets when character settings is undefined", async () => {
    mockRuntime.character = { name: "TestAgent" } as unknown as Character;

    const service = new EnvManagerService();
    const testable = service as unknown as EnvManagerServiceTestable;
    testable.runtime = mockRuntime;
    testable.envVarCache = {
      "test-plugin": {
        TEST_VAR: {
          value: "test-value",
          type: "api_key" as const,
          required: true,
          description: "Test",
          canGenerate: false,
          status: "valid" as const,
          attempts: 0,
          plugin: "test-plugin",
          createdAt: Date.now(),
        },
      },
    };

    await testable.saveEnvVarsToSecrets();

    expect(mockRuntime.character.settings).toBeDefined();
    expect(mockRuntime.character.settings.secrets).toBeDefined();
    expect(mockRuntime.character.settings.secrets.ENV_TEST_VAR).toBe(
      "test-value",
    );
  });

  it("should handle plugins without declaredEnvVars", async () => {
    mockRuntime.plugins = [
      {
        name: "test-plugin",
        // No declaredEnvVars property
      } as unknown as Plugin,
    ];

    const service = await EnvManagerService.start(mockRuntime);
    const envVars = await service.getEnvVarsForPlugin("test-plugin");

    expect(envVars).toBeNull();
  });

  it("should use default value from declared env vars", async () => {
    mockRuntime.plugins = [
      {
        name: "test-plugin",
        declaredEnvVars: {
          API_KEY: {
            type: "api_key",
            required: false,
            description: "API Key",
            defaultValue: "default-key",
          },
        },
      } as unknown as PluginWithDeclaredEnvVars,
    ] as Plugin[];

    const service = await EnvManagerService.start(mockRuntime);
    const envVars = await service.getEnvVarsForPlugin("test-plugin");

    expect(envVars?.API_KEY.value).toBe("default-key");
    expect(envVars?.API_KEY.status).toBe("valid");
  });

  it("should handle different variable type inference cases", async () => {
    mockRuntime.character.settings.secrets = {
      TOKEN_VAR: "",
      PRIVATE_KEY_VAR: "",
      PUBLIC_KEY_VAR: "",
      ENDPOINT_VAR: "",
      SECRET_VAR: "",
      KEY_VAR: "",
      CONFIG_VAR: "",
    };

    const service = await EnvManagerService.start(mockRuntime);
    const envVars = await service.getEnvVarsForPlugin("character");

    expect(envVars?.TOKEN_VAR.type).toBe("api_key");
    expect(envVars?.PRIVATE_KEY_VAR.type).toBe("private_key");
    expect(envVars?.PUBLIC_KEY_VAR.type).toBe("public_key");
    expect(envVars?.ENDPOINT_VAR.type).toBe("url");
    expect(envVars?.SECRET_VAR.type).toBe("secret");
    expect(envVars?.KEY_VAR.type).toBe("secret");
    expect(envVars?.CONFIG_VAR.type).toBe("config");
  });
});
