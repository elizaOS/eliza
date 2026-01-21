/**
 * Singleton Utility
 *
 * Provides a reusable singleton pattern for server instances.
 * Prevents double initialization and handles cleanup.
 */

/**
 * Type for singleton storage values.
 * Uses unknown for type safety - callers must type cast when retrieving.
 */
type SingletonValue = unknown;

/**
 * Type for the global object used for singleton storage.
 * Values are stored as unknown and type-cast when retrieved.
 */
interface GlobalSingletonStorage {
  [key: string]: SingletonValue;
}

/**
 * Helper to get typed global object for singleton storage.
 */
function getGlobalStorage(): GlobalSingletonStorage {
  // Global is a special Node.js object that holds global state
  return global as GlobalSingletonStorage;
}

/**
 * Creates a singleton getter/setter pattern for a type T
 */
export function createSingleton<T>(): {
  getInstance: () => T | null;
  setInstance: (instance: T) => void;
  clearInstance: () => void;
} {
  let instance: T | null = null;

  return {
    getInstance: () => instance,
    setInstance: (inst: T) => {
      instance = inst;
    },
    clearInstance: () => {
      instance = null;
    },
  };
}

/**
 * Creates a global singleton that survives hot module reloads
 * Uses Node.js global object to persist across module reloads
 */
export function createGlobalSingleton<T>(globalKey: string): {
  getInstance: () => T | null;
  setInstance: (instance: T) => void;
  clearInstance: () => void;
} {
  const globalObj = getGlobalStorage();

  return {
    getInstance: () => {
      const value = globalObj[globalKey];
      return (value as T | undefined) || null;
    },
    setInstance: (instance: T) => {
      globalObj[globalKey] = instance;
    },
    clearInstance: () => {
      globalObj[globalKey] = undefined;
    },
  };
}

/**
 * Creates a port-aware singleton for WebSocket servers
 * Prevents multiple servers from binding to the same port
 */
export function createPortSingleton<T>(
  globalKey: string,
  portKey = `${globalKey}Port`,
): {
  getInstance: (port?: number) => T | null;
  setInstance: (instance: T, port?: number) => void;
  clearInstance: () => void;
} {
  const globalObj = getGlobalStorage();

  return {
    getInstance: (port?: number) => {
      const existing = globalObj[globalKey] as T | undefined;
      const existingPort = globalObj[portKey] as number | undefined;

      // If port is specified, only return if it matches
      if (port !== undefined && existingPort !== port) {
        return null;
      }

      return existing || null;
    },
    setInstance: (instance: T, port?: number) => {
      globalObj[globalKey] = instance;
      if (port !== undefined) {
        globalObj[portKey] = port;
      }
    },
    clearInstance: () => {
      globalObj[globalKey] = undefined;
      globalObj[portKey] = undefined;
    },
  };
}
