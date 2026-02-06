#!/usr/bin/env node

// mldy — alias for the milaidy CLI.
// Delegates to the milaidy package's CLI entry point so that
// `npx mldy` behaves identically to `npx milaidy`.

import module from "node:module";

// https://nodejs.org/api/module.html#module-compile-cache
if (module.enableCompileCache && !process.env.NODE_DISABLE_COMPILE_CACHE) {
  try {
    module.enableCompileCache();
  } catch {
    // Ignore errors
  }
}

await import("milaidy/cli-entry");
