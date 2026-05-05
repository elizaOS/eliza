import { vi } from "vitest";

vi.mock("@elizaos/core", () => {
  let trajectoryContext: { trajectoryStepId?: string } | undefined;
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
      TEXT_TO_SPEECH: "TEXT_TO_SPEECH",
      TRANSCRIPTION: "TRANSCRIPTION",
    },
    logger,
    recordLlmCall: async (
      runtime: {
        getService?: (name: string) => {
          logLlmCall?: (call: Record<string, unknown>) => void;
        } | null;
      },
      details: Record<string, unknown>,
      fn: () => Promise<unknown>
    ) => {
      const result = await fn();
      const response =
        typeof details.response === "string"
          ? details.response
          : typeof result === "string"
            ? result
            : "";
      const trajectoryLogger = runtime.getService?.("trajectories");
      if (trajectoryContext?.trajectoryStepId && trajectoryLogger?.logLlmCall) {
        trajectoryLogger.logLlmCall({
          stepId: trajectoryContext.trajectoryStepId,
          ...details,
          response,
          latencyMs: 0,
        });
      }
      return result;
    },
    runWithTrajectoryContext: async (
      context: { trajectoryStepId?: string },
      fn: () => Promise<unknown>
    ) => {
      const previous = trajectoryContext;
      trajectoryContext = context;
      try {
        return await fn();
      } finally {
        trajectoryContext = previous;
      }
    },
  };
});
