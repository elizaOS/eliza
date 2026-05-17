/**
 * Process-lifecycle cleanup for plugin-omnivoice.
 *
 * libomnivoice contexts wrap a long-lived GGML model in native memory.
 * The plugin caches both a speech context (in `./index`) and a singing
 * context (in `./singing`) at module scope for the lifetime of the
 * process, since model load dominates synthesis cost (~1–3s for Q8_0).
 *
 * Without an explicit teardown, `ov_free` is never called, and the
 * model memory leaks across runtime shutdowns inside long-lived hosts
 * (CLI watchers, desktop shells, tests that import the plugin
 * repeatedly). This module registers a single set of process listeners
 * that release both caches on `beforeExit`, `SIGTERM`, and `SIGINT`.
 */

import process from "node:process";
import { logger } from "@elizaos/core";
import { closeSingingContext } from "./singing";

type Closer = () => void;

let registered = false;
let shuttingDown = false;
const extraClosers = new Set<Closer>();

/**
 * Register an additional closer to run during shutdown. Used by
 * `./index` to plug in its module-scoped speech-context cache without
 * pulling `./index` into shutdown's import graph (which would create a
 * cycle).
 */
export function registerOmnivoiceCloser(fn: Closer): void {
  extraClosers.add(fn);
}

/** Test-only — drop all registered closers. */
export function _clearOmnivoiceClosers(): void {
  extraClosers.clear();
}

/**
 * Free every cached omnivoice context. Idempotent — safe to call from
 * a signal handler, `beforeExit`, the plugin shutdown method, and from
 * tests, in any order.
 */
export function closeOmnivoiceShutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    closeSingingContext();
    for (const close of extraClosers) close();
    logger.info("[plugin-omnivoice] released cached contexts on shutdown");
  } finally {
    // Reset so a fresh ctx allocated after shutdown (e.g. in tests that
    // re-open the plugin in the same process) can still be released.
    shuttingDown = false;
  }
}

/**
 * Install process listeners for `beforeExit`, `SIGTERM`, and `SIGINT`.
 * Guarded against double-registration so importing the plugin multiple
 * times in the same process doesn't pile up listeners. Returns `true`
 * the first time it actually registers, `false` on subsequent calls.
 */
export function registerOmnivoiceShutdownHooks(): boolean {
  if (registered) return false;
  registered = true;
  process.on("beforeExit", closeOmnivoiceShutdown);
  process.on("SIGTERM", closeOmnivoiceShutdown);
  process.on("SIGINT", closeOmnivoiceShutdown);
  return true;
}

/** Test-only — reset the registration flag so tests can re-exercise it. */
export function _resetShutdownRegistration(): void {
  if (registered) {
    process.off("beforeExit", closeOmnivoiceShutdown);
    process.off("SIGTERM", closeOmnivoiceShutdown);
    process.off("SIGINT", closeOmnivoiceShutdown);
  }
  registered = false;
  shuttingDown = false;
}

// Register on module load so any importer of the plugin gets cleanup
// without having to remember to call the helper. The flag prevents
// duplicate listeners if both `./index` and `./shutdown` are imported.
registerOmnivoiceShutdownHooks();
