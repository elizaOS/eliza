import { elizaLogger } from '@elizaos/core';

// Add client-specific context to logs
const clientLogger = {
  info: (msg: string, ...args: any[]) => {
    elizaLogger.info({ source: 'client' }, msg, ...args);
  },
  error: (msg: string, ...args: any[]) => {
    elizaLogger.error({ source: 'client' }, msg, ...args);
  },
  warn: (msg: string, ...args: any[]) => {
    elizaLogger.warn({ source: 'client' }, msg, ...args);
  },
  debug: (msg: string, ...args: any[]) => {
    elizaLogger.debug({ source: 'client' }, msg, ...args);
  },
};

export default clientLogger;
