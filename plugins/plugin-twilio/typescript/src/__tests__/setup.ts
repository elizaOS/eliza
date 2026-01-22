import { vi } from "vitest";

// Mock @elizaos/core module
vi.mock("@elizaos/core", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
  Service: class Service {
    runtime: any;
    constructor() {}
    async initialize(runtime: any) {
      this.runtime = runtime;
    }
    async stop() {}
    get capabilityDescription() {
      return "";
    }
  },
}));

// Don't mock console in setup - let individual tests handle it
