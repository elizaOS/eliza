/**
 * Verifies dependency sourcemap filtering stays limited to known packaging
 * defects and continues forwarding workspace warnings and genuine failures.
 */
import type { Logger } from "vite";
import { describe, expect, it, vi } from "vitest";

import {
  createDependencySourcemapFilteringLogger,
  isKnownDependencyMissingSourcemapWarning,
} from "./dependency-sourcemap-logger.ts";

const repositoryRoot = "/workspace/eliza";

function createLoggerSpies(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    warnOnce: vi.fn(),
    error: vi.fn(),
    clearScreen: vi.fn(),
    hasErrorLogged: vi.fn(() => false),
    hasWarned: false,
  };
}

describe("known dependency missing-sourcemap warnings", () => {
  it.each([
    `Sourcemap for "${repositoryRoot}/node_modules/.bun/entities@4.5.0/node_modules/entities/lib/esm/index.js" points to missing source files`,
    `Sourcemap for "${repositoryRoot}/node_modules/.bun/@microsoft+fetch-event-source@2.0.1/node_modules/@microsoft/fetch-event-source/lib/cjs/index.js" points to missing source files`,
    [
      `Failed to load source map for ${repositoryRoot}/node_modules/.bun/typescript@6.0.3/node_modules/typescript/lib/typescript.js.`,
      "Error: An error occurred while trying to read the map file at typescript.js.map",
      `Error: ENOENT: no such file or directory, open '${repositoryRoot}/node_modules/.bun/typescript@6.0.3/node_modules/typescript/lib/typescript.js.map'`,
    ].join("\n"),
  ])("recognizes %s", (message) => {
    expect(isKnownDependencyMissingSourcemapWarning(message)).toBe(true);
  });

  it.each([
    `Sourcemap for "${repositoryRoot}/packages/core/src/index.ts" points to missing source files`,
    `Sourcemap for "${repositoryRoot}/node_modules/example/index.js" points to missing source files`,
    `Failed to load source map for ${repositoryRoot}/node_modules/typescript/lib/typescript.js.\nError: Unexpected token in source map`,
    `Failed to load source map for ${repositoryRoot}/packages/core/src/index.ts.\nError: ENOENT: missing index.ts.map`,
  ])("preserves %s", (message) => {
    expect(isKnownDependencyMissingSourcemapWarning(message)).toBe(false);
  });

  it("filters known warnings and forwards unrelated warn methods", () => {
    const baseLogger = createLoggerSpies();
    const originalWarn = baseLogger.warn;
    const originalWarnOnce = baseLogger.warnOnce;
    const originalError = baseLogger.error;
    const logger = createDependencySourcemapFilteringLogger(baseLogger);
    const knownWarning = `Sourcemap for "${repositoryRoot}/node_modules/entities/lib/esm/index.js" points to missing source files`;

    logger.warn(knownWarning);
    logger.warnOnce(knownWarning);
    logger.warn("workspace warning");
    logger.warnOnce("workspace warning once");
    logger.error("workspace error");

    expect(originalWarn).toHaveBeenCalledTimes(1);
    expect(originalWarn).toHaveBeenCalledWith("workspace warning", undefined);
    expect(originalWarnOnce).toHaveBeenCalledTimes(1);
    expect(originalWarnOnce).toHaveBeenCalledWith(
      "workspace warning once",
      undefined,
    );
    expect(originalError).toHaveBeenCalledTimes(1);
    expect(originalError).toHaveBeenCalledWith("workspace error");
  });
});
