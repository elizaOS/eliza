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
    buildCanonicalSystemPrompt: ({
      character,
    }: {
      character?: { system?: string | null } | null;
    }) => character?.system?.trim() || "",
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
    renderChatMessagesForPrompt: (
      messages?: Array<{ role?: string; content?: unknown }>,
      options?: { omitDuplicateSystem?: string }
    ) => {
      if (!Array.isArray(messages) || messages.length === 0) return undefined;
      return messages
        .filter(
          (message) =>
            !(
              message.role === "system" &&
              typeof message.content === "string" &&
              message.content.trim() === options?.omitDuplicateSystem?.trim()
            )
        )
        .map((message) =>
          typeof message.content === "string" ? `${message.role ?? "user"}: ${message.content}` : ""
        )
        .filter(Boolean)
        .join("\n");
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
    resolveEffectiveSystemPrompt: ({
      params,
      fallback,
    }: {
      params?: { system?: unknown; messages?: Array<{ role?: string; content?: string }> };
      fallback?: string | null;
    }) => {
      if (params && Object.hasOwn(params, "system")) {
        return typeof params.system === "string" ? params.system.trim() : undefined;
      }
      const first = params?.messages?.[0];
      if (first?.role === "system" && typeof first.content === "string") {
        return first.content.trim() || undefined;
      }
      return fallback?.trim() || undefined;
    },
  };
});
