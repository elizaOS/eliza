import {
  type Action,
  elizaLogger,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import {
  getValidationKeywordTerms,
  textIncludesKeywordTerm,
} from "@elizaos/shared";

const LOG_LEVEL_COMMAND_TERMS = getValidationKeywordTerms(
  "action.logLevel.command",
  {
    includeAllLocales: true,
  },
);
const LOG_LEVEL_SET_TERMS = getValidationKeywordTerms(
  "action.logLevel.setVerb",
  {
    includeAllLocales: true,
  },
);
const LOG_LEVEL_DOMAIN_TERMS = getValidationKeywordTerms(
  "action.logLevel.domain",
  {
    includeAllLocales: true,
  },
);
const LOG_LEVEL_ALIASES = {
  trace: getValidationKeywordTerms("action.logLevel.level.trace", {
    includeAllLocales: true,
  }),
  debug: getValidationKeywordTerms("action.logLevel.level.debug", {
    includeAllLocales: true,
  }),
  info: getValidationKeywordTerms("action.logLevel.level.info", {
    includeAllLocales: true,
  }),
  warn: getValidationKeywordTerms("action.logLevel.level.warn", {
    includeAllLocales: true,
  }),
  error: getValidationKeywordTerms("action.logLevel.level.error", {
    includeAllLocales: true,
  }),
} as const;

type CanonicalLogLevel = keyof typeof LOG_LEVEL_ALIASES;

function containsLogLevelTerm(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => textIncludesKeywordTerm(text, term));
}

function resolveLogLevel(text: string): CanonicalLogLevel | null {
  const entries = Object.entries(LOG_LEVEL_ALIASES) as Array<
    [CanonicalLogLevel, readonly string[]]
  >;
  for (const [level, aliases] of entries) {
    if (containsLogLevelTerm(text, aliases)) {
      return level;
    }
  }
  return null;
}

export const logLevelAction: Action = {
  name: "LOG_LEVEL",
  contexts: ["admin", "settings", "agent_internal"],
  roleGate: { minRole: "ADMIN" },
  similes: [
    "SET_LOG_LEVEL",
    "CHANGE_LOG_LEVEL",
    "DEBUG_MODE",
    "SET_DEBUG",
    "CONFIGURE_LOGGING",
  ],
  description:
    "Set the log level for the current session (trace, debug, info, warn, error).",
  descriptionCompressed:
    "set log level current session (trace, debug, info, warn, error)",
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text || "";
    const hasLevel = resolveLogLevel(text) !== null;
    if (!hasLevel) {
      return false;
    }

    return (
      containsLogLevelTerm(text, LOG_LEVEL_COMMAND_TERMS) ||
      (containsLogLevelTerm(text, LOG_LEVEL_SET_TERMS) &&
        containsLogLevelTerm(text, LOG_LEVEL_DOMAIN_TERMS))
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: HandlerOptions | undefined,
    callback?: HandlerCallback,
  ): Promise<import("@elizaos/core").ActionResult> => {
    const params = _options?.parameters as { level?: string } | undefined;
    const text = message.content.text || "";
    const levels = Object.keys(LOG_LEVEL_ALIASES) as CanonicalLogLevel[];
    const requestedLevel =
      typeof params?.level === "string" ? params.level.toLowerCase() : "";
    const level = levels.includes(requestedLevel as CanonicalLogLevel)
      ? (requestedLevel as CanonicalLogLevel)
      : resolveLogLevel(text);

    if (!level) {
      if (callback) {
        callback({
          text: `Please specify a valid log level: ${levels.join(", ")}.`,
          action: "LOG_LEVEL_FAILED",
        });
      }
      return {
        success: false,
        text: "Invalid log level.",
        values: { error: "INVALID_LOG_LEVEL" },
        data: { actionName: "LOG_LEVEL", validLevels: levels },
        error: "Invalid log level",
      };
    }

    // Set the override
    const runtimeWithOverrides = runtime as IAgentRuntime & {
      logLevelOverrides?: Map<string, string>;
    };

    if (runtimeWithOverrides.logLevelOverrides) {
      runtimeWithOverrides.logLevelOverrides.set(message.roomId, level);
      elizaLogger.info(`Log level set to ${level} for room ${message.roomId}`);

      if (callback) {
        callback({
          text: `Log level changed to **${level.toUpperCase()}** for this room.`,
          action: "LOG_LEVEL_SET",
        });
      }
      return {
        success: true,
        text: `Log level changed to ${level.toUpperCase()} for this room.`,
        values: { level },
        data: { actionName: "LOG_LEVEL", level },
      };
    } else {
      if (callback) {
        callback({
          text: "Dynamic log levels are not supported by this runtime version.",
          action: "LOG_LEVEL_FAILED",
        });
      }
      return {
        success: false,
        text: "Dynamic log levels are not supported by this runtime version.",
        values: { error: "NOT_SUPPORTED" },
        data: { actionName: "LOG_LEVEL" },
        error: "Not supported",
      };
    }
  },
  parameters: [
    {
      name: "level",
      description: "Log level to set for the current room.",
      required: true,
      schema: {
        type: "string" as const,
        enum: ["trace", "debug", "info", "warn", "error"],
      },
    },
  ],
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "/logLevel debug" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Log level changed to **DEBUG** for this room.",
          action: "LOG_LEVEL_SET",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Set log level to trace" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Log level changed to **TRACE** for this room.",
          action: "LOG_LEVEL_SET",
        },
      },
    ],
  ],
};
