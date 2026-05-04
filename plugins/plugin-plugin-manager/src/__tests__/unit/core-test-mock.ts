import { vi } from "vitest";

vi.mock("@elizaos/core", () => {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  };

  class Service {
    protected runtime: unknown;

    constructor(runtime?: unknown) {
      this.runtime = runtime;
    }
  }

  return {
    ModelType: {
      TEXT_SMALL: "TEXT_SMALL",
    },
    Service,
    checkSenderRole: vi.fn(async () => ({ isOwner: false, isAdmin: false })),
    createUniqueUuid: vi.fn((_runtime: unknown, value: string) => `mock-${value}`),
    logger,
    resolveCanonicalOwnerIdForMessage: vi.fn(async () => null),
    validateActionKeywords: vi.fn(() => false),
    validateActionRegex: vi.fn(() => false),
  };
});
