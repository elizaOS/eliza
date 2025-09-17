#!/usr/bin/env node

// Thin shim that defers to @elizaos/cli's binary (ESM).
// Keeps this package as an alias while ensuring the same behavior.
import '@elizaos/cli/dist/index.js';
