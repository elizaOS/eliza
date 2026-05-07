import { vi } from "vitest";

vi.mock("@elizaos/core", () => {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  };

  return {
    EventType: {
      MODEL_USED: "MODEL_USED",
    },
    ModelType: {
      ACTION_PLANNER: "ACTION_PLANNER",
      OBJECT_LARGE: "OBJECT_LARGE",
      OBJECT_SMALL: "OBJECT_SMALL",
      RESPONSE_HANDLER: "RESPONSE_HANDLER",
      TEXT_LARGE: "TEXT_LARGE",
      TEXT_MEGA: "TEXT_MEGA",
      TEXT_MEDIUM: "TEXT_MEDIUM",
      TEXT_NANO: "TEXT_NANO",
      TEXT_SMALL: "TEXT_SMALL",
    },
    logger,
    recordLlmCall: async (
      _runtime: unknown,
      _details: Record<string, unknown>,
      fn: () => Promise<unknown>
    ) => fn(),
  };
});
