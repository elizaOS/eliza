import { elizaLogger } from '@elizaos/core';

// Add client-specific context to logs
const clientLogger = {
  info: (msg: string, ...args: unknown[]) => {
    elizaLogger.info({ source: 'client' }, msg, ...args);
  },
  error: (msg: string, ...args: unknown[]) => {
    elizaLogger.error({ source: 'client' }, msg, ...args);
  },
  warn: (msg: string, ...args: unknown[]) => {
    elizaLogger.warn({ source: 'client' }, msg, ...args);
  },
  debug: (msg: string, ...args: unknown[]) => {
    elizaLogger.debug({ source: 'client' }, msg, ...args);
  },
};

export default clientLogger;
