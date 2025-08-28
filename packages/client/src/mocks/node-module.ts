/**
 * Mock for Node.js module API for browser compatibility
 * This provides stub implementations for Node.js module functions
 * that don't exist in the browser environment
 */

// Track warned modules to avoid spamming console
const warnedModules = new Set<string>();

// Mock createRequire function that returns appropriate polyfills
export const createRequire = (_url?: string) => {
  // Return a mock require function that provides polyfills
  return (id: string) => {
    // Only warn once per module
    if (!warnedModules.has(id)) {
      warnedModules.add(id);
      console.debug(`Browser polyfill: Redirecting require('${id}') to browser-compatible version`);
    }

    // Return appropriate polyfills for known modules
    if (id === 'crypto' || id === 'node:crypto') {
      // Return the crypto-browserify polyfill if available
      if (typeof window !== 'undefined' && (window as any).crypto) {
        return (window as any).crypto;
      }
      return {};
    }

    if (id === 'buffer' || id === 'node:buffer') {
      // Return the buffer polyfill if available
      if (typeof window !== 'undefined' && (window as any).Buffer) {
        return { Buffer: (window as any).Buffer };
      }
      return {};
    }

    return {};
  };
};

// Mock module object
export const Module = {
  createRequire,
  _extensions: {},
  _cache: {},
  _pathCache: {},
  _nodeModulePaths: () => [],
  globalPaths: [],
  syncBuiltinESMExports: () => {},
  isBuiltin: (_module: string) => false,
};

// Export as default for compatibility
export default {
  createRequire,
  Module,
};
