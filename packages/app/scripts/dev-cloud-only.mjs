#!/usr/bin/env node

/**
 * Compatibility entrypoint for the hosted Cloud onboarding policy. Ordinary
 * local development now uses this policy against staging by default; keep the
 * named lane for existing automation and explicit operator intent.
 */

process.env.VITE_ELIZA_DESKTOP_RUNTIME_MODE = "cloud";
await import("./dev.mjs");
