/**
 * Mock for Node.js module API for browser compatibility
 * This provides stub implementations for Node.js module functions
 * that don't exist in the browser environment
 */

// Mock createRequire function that returns a no-op
export const createRequire = (_url?: string) => {
  // Return a mock require function
  return (_id: string) => {
    console.warn(`Attempted to require module: ${_id} in browser environment`);
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
