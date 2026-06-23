import { createLogger, type Logger } from '@elizaos/core';

const pluginLogger = createLogger({ namespace: 'agent-commerce' });

export function getPluginLogger(runtime?: { logger?: Logger }): Logger {
  return runtime?.logger ?? pluginLogger;
}

export { pluginLogger };
