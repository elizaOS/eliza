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
    ChannelType: {
      DM: "DM",
    },
    ModelType: {
      TEXT_LARGE: "TEXT_LARGE",
      TEXT_SMALL: "TEXT_SMALL",
    },
    Service,
    logger,
  };
});
