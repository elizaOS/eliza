import { afterAll } from "vitest";
import { withIsolatedTestHome } from "./test-env";

process.env.VITEST = "true";
process.env.LOG_LEVEL ??= "error";

// Snapshot the file-level environment so live tests cannot leak mutations into
// later files when Vitest reuses the worker.
const fileEnvSnapshot = { ...process.env };
const testEnv = withIsolatedTestHome();

afterAll(() => {
  testEnv.cleanup();
});

afterAll(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in fileEnvSnapshot)) {
      delete process.env[key];
    } else if (process.env[key] !== fileEnvSnapshot[key]) {
      process.env[key] = fileEnvSnapshot[key];
    }
  }

  for (const key of Object.keys(fileEnvSnapshot)) {
    if (!(key in process.env)) {
      process.env[key] = fileEnvSnapshot[key];
    }
  }
});

afterAll(() => {
  // Some live/integration-style tests leave filesystem watchers open, which
  // keeps Vitest from exiting cleanly on local runs.
  const getActiveHandles = (
    process as {
      _getActiveHandles?: () => unknown[];
    }
  )._getActiveHandles;
  const handles = getActiveHandles?.() ?? [];

  for (const handle of handles) {
    if (!handle || typeof handle !== "object") {
      continue;
    }

    const name = (handle as { constructor?: { name?: string } }).constructor
      ?.name;
    if (name !== "FSWatcher" && name !== "FSEvent" && name !== "StatWatcher") {
      continue;
    }

    try {
      (handle as { close?: () => void }).close?.();
    } catch {
      // Best-effort cleanup only.
    }
  }
});
