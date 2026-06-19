/**
 * Stub for electron-fetch to prevent electron dependency in browser builds
 *
 * electron-fetch checks process.versions.electron at runtime, so in non-electron
 * environments it falls back to regular fetch. This stub provides a compatible
 * interface that uses the global fetch API or node-fetch for Node.js environments.
 *
 * The actual electron-fetch module tries to require('electron') which causes
 * webpack bundling issues. This stub avoids that by not requiring electron at all.
 */

// Use node-fetch for Node.js environments, or global fetch for browser
// This matches electron-fetch's behavior when electron is not available
if (typeof window === "undefined" && typeof require !== "undefined") {
  // Node.js environment - use node-fetch
  try {
    module.exports = require("node-fetch");
  } catch (_e) {
    // Fallback to global fetch if node-fetch is not available
    module.exports = globalThis.fetch || fetch;
  }
} else {
  // Browser environment - use global fetch
  module.exports = globalThis.fetch || fetch;
}
