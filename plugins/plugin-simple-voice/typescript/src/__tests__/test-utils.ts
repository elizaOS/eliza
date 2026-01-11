import { type IAgentRuntime, logger, type Memory, type State, type UUID } from "@elizaos/core";
import { vi } from "vitest";
import { SamTTSService } from "../services/SamTTSService";

/**
 * Create a mock runtime for testing
 */
export function createMockRuntime(): IAgentRuntime {
  const services = new Map<string, unknown>();

  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001" as UUID,
    getSetting: vi.fn(() => null),
    getService: vi.fn((serviceType: string) => services.get(serviceType)),
    hasService: vi.fn((serviceType: string) => services.has(serviceType)),
    registerService: vi.fn((serviceType: string, service: unknown) => {
      services.set(serviceType, service);
    }),
    initialize: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    evaluate: vi.fn(() => Promise.resolve(null)),
    processActions: vi.fn(() => Promise.resolve()),
    useModel: vi.fn(() => Promise.resolve("test response")),
    ensureConnection: vi.fn(() => Promise.resolve()),
    composeState: vi.fn(() => Promise.resolve({ data: {}, values: {}, text: "" } as State)),
    createMemory: vi.fn(() => Promise.resolve("test-memory-id" as UUID)),
    actions: [],
    providers: [],
    evaluators: [],
    services,
    db: null,
    plugins: [],
    routes: [],
    logger,
    character: {
      name: "Test Agent",
      id: "00000000-0000-0000-0000-000000000001" as UUID,
      username: "test-agent",
      bio: ["Test agent"],
      settings: {},
      system: "Test system",
      plugins: ["@elizaos/plugin-simple-voice"],
    },
  } as IAgentRuntime;

  // Register SAM service
  const samService = new SamTTSService(runtime);
  services.set("SAM_TTS", samService);

  return runtime;
}

/**
 * Set up logger spies
 */
export function setupLoggerSpies(): void {
  vi.spyOn(logger, "info");
  vi.spyOn(logger, "error");
  vi.spyOn(logger, "warn");
  vi.spyOn(logger, "debug");
}

/**
 * Create a mock memory
 */
export function createMockMemory(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000002" as UUID,
    entityId: "00000000-0000-0000-0000-000000000003" as UUID,
    agentId: "00000000-0000-0000-0000-000000000001" as UUID,
    roomId: "00000000-0000-0000-0000-000000000004" as UUID,
    content: { text },
    createdAt: Date.now(),
  };
}
