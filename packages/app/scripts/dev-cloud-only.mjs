#!/usr/bin/env node

/**
 * Starts the ordinary Vite renderer with the hosted Cloud onboarding policy.
 * The default dev command intentionally keeps the local/cloud/remote chooser;
 * this explicit lane mirrors production Cloud sign-in without changing it.
 */

process.env.VITE_ELIZA_DESKTOP_RUNTIME_MODE = "cloud";
await import("./dev.mjs");
