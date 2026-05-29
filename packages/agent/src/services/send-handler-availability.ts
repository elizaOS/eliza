import { type IAgentRuntime, logger } from "@elizaos/core";

type RuntimeWithSendHandlers = IAgentRuntime & {
  sendHandlers?: Map<string, unknown>;
};

const missingSendHandlerLogs = new Set<string>();

export function hasRuntimeSendHandler(
  runtime: IAgentRuntime,
  source: string,
): boolean {
  const sendHandlers = (runtime as RuntimeWithSendHandlers).sendHandlers;
  if (!(sendHandlers instanceof Map)) {
    // The handler registry could not be introspected. This gates whether we
    // attempt delivery, so treat an unknown registry as "no handler" — skip
    // and log rather than asserting availability we can't verify.
    return false;
  }
  return sendHandlers.has(source);
}

export function logMissingSendHandlerOnce(
  context: string,
  source: string,
): void {
  const key = `${context}:${source}`;
  if (missingSendHandlerLogs.has(key)) {
    return;
  }
  missingSendHandlerLogs.add(key);
  logger.info(
    `[${context}] Send handler "${source}" is not registered yet; skipping delivery until runtime wiring completes`,
  );
}

export function _resetMissingSendHandlerLogsForTests(): void {
  missingSendHandlerLogs.clear();
}
