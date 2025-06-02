// ESM shim for better-sqlite3 and other native modules
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// Only set these if they're not already defined
if (typeof globalThis.__filename === 'undefined') {
  const currentFilename = fileURLToPath(import.meta.url);
  const currentDirname = dirname(currentFilename);

  // Define getters that calculate the values dynamically
  Object.defineProperty(globalThis, '__filename', {
    get() {
      // Try to get the caller's import.meta.url
      const err = new Error();
      const stack = err.stack?.split('\n') || [];
      // This is a fallback - in real usage, better-sqlite3 will have its own context
      return currentFilename;
    },
    configurable: true,
  });

  Object.defineProperty(globalThis, '__dirname', {
    get() {
      return currentDirname;
    },
    configurable: true,
  });
}

export {};
