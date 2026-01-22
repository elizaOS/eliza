import { vi } from "vitest";

// Mock @elizaos/core module
vi.mock("@elizaos/core", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
  ChannelType: {
    DM: "DM",
    GROUP: "GROUP",
  },
  ContentType: {
    IMAGE: "IMAGE",
    VIDEO: "VIDEO",
    AUDIO: "AUDIO",
    DOCUMENT: "DOCUMENT",
  },
  EventType: {
    MESSAGE_RECEIVED: "message:received",
  },
  createUniqueUuid: vi.fn((_runtime: object, input: string) => `uuid:${input}`),
  stringToUuid: vi.fn((input: string) => input),
  createMessageMemory: vi.fn((payload: object) => payload),
  Service: class Service {
    runtime: object | null = null;
    async initialize(runtime: object) {
      this.runtime = runtime;
    }
    async stop() {}
    get capabilityDescription() {
      return "";
    }
  },
}));

// Don't mock console in setup - let individual tests handle it
