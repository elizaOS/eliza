import { type AgentRuntime, elizaLogger, type Logger } from "@elizaos/core";
import { getRequestContext } from "@/lib/services/entity-settings/request-context";
import { logger } from "@/lib/utils/logger";

const requestContextGetSettingPatched = Symbol("requestContextGetSettingPatched");

type RuntimeWithRequestContextPatch = AgentRuntime & {
  [requestContextGetSettingPatched]?: true;
};

interface GlobalWithEliza {
  logger?: Logger;
}

const globalAny = globalThis as GlobalWithEliza;

export function assertPersistentDatabaseRequired(
  runtime: Pick<AgentRuntime, "getSetting" | "agentId">,
): void {
  const raw = runtime.getSetting("ALLOW_NO_DATABASE") ?? process.env.ALLOW_NO_DATABASE;
  const normalized = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    throw new Error(
      `Agent cloud requires persistent database storage and does not permit ALLOW_NO_DATABASE (agent ${runtime.agentId}). Remove ALLOW_NO_DATABASE from config/env and keep plugin-sql configured.`,
    );
  }
}

export function ensureRuntimeLogger(runtime: AgentRuntime): void {
  const runtimeWithPatch = runtime as RuntimeWithRequestContextPatch;
  if (!runtimeWithPatch[requestContextGetSettingPatched]) {
    const baseGetSetting = runtime.getSetting.bind(runtime);
    runtime.getSetting = ((key: string) => {
      const requestCtx = getRequestContext();
      if (requestCtx?.entitySettings.has(key)) {
        return requestCtx.entitySettings.get(key) ?? null;
      }
      const runtimeSettings = Reflect.get(runtime, "settings");
      if (
        runtimeSettings &&
        typeof runtimeSettings === "object" &&
        Object.hasOwn(runtimeSettings, key)
      ) {
        return (runtimeSettings as Record<string, string | undefined>)[key] ?? null;
      }
      return baseGetSetting(key);
    }) as AgentRuntime["getSetting"];
    runtimeWithPatch[requestContextGetSettingPatched] = true;
  }

  if (!runtime.logger?.log) {
    runtime.logger = {
      log: logger.info.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      debug: console.debug.bind(console),
      success: (message: string) => logger.info(`✓ ${message}`),
      notice: console.info.bind(console),
    } as Logger & { notice: typeof console.info };
  }
}

export function initializeLoggers(): void {
  if (elizaLogger) {
    elizaLogger.log = logger.info.bind(console);
    elizaLogger.info = console.info.bind(console);
    elizaLogger.warn = console.warn.bind(console);
    elizaLogger.error = console.error.bind(console);
    elizaLogger.debug = console.debug.bind(console);
    elizaLogger.success = (obj: string | Error | Record<string, unknown>, msg?: string) => {
      logger.info(typeof obj === "string" ? `✓ ${obj}` : ["✓", obj, msg]);
    };
  }

  if (typeof globalThis !== "undefined" && !globalAny.logger) {
    globalAny.logger = {
      level: "info",
      log: logger.info.bind(console),
      trace: console.trace.bind(console),
      debug: console.debug.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      fatal: console.error.bind(console),
      success: (obj: string | Error | Record<string, unknown>, msg?: string) => {
        logger.info(typeof obj === "string" ? `✓ ${obj}` : ["✓", obj, msg]);
      },
      progress: logger.info.bind(console),
      clear: () => console.clear(),
      child: () => globalAny.logger!,
    };
  }
}
