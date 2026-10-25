/**
 * Filters known third-party missing-sourcemap noise from Vite test output while
 * preserving workspace diagnostics and every other warning or error.
 */
import { createLogger, type Logger, type Plugin } from "vite";

const MISSING_SOURCE_FILES_PREFIX = 'Sourcemap for "';
const MISSING_SOURCE_FILES_SUFFIX = '" points to missing source files';
const FAILED_SOURCE_MAP_PREFIX = "Failed to load source map for ";
const filteredLoggers = new WeakSet<Logger>();

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function isDependencyFile(filePath: string, packageName: string): boolean {
  const normalizedPath = normalizePath(filePath);
  return normalizedPath.includes(`/node_modules/${packageName}/`);
}

function getMissingSourceFilesPath(message: string): string | undefined {
  if (
    message.includes("\n") ||
    !message.startsWith(MISSING_SOURCE_FILES_PREFIX) ||
    !message.endsWith(MISSING_SOURCE_FILES_SUFFIX)
  ) {
    return undefined;
  }

  return message.slice(
    MISSING_SOURCE_FILES_PREFIX.length,
    -MISSING_SOURCE_FILES_SUFFIX.length,
  );
}

function isKnownMissingSourcesWarning(message: string): boolean {
  const filePath = getMissingSourceFilesPath(message);
  if (!filePath) return false;

  return (
    isDependencyFile(filePath, "entities") ||
    isDependencyFile(filePath, "@microsoft/fetch-event-source")
  );
}

function isKnownMissingTypeScriptMapWarning(message: string): boolean {
  if (!message.startsWith(FAILED_SOURCE_MAP_PREFIX)) return false;

  const [firstLine = ""] = message.split("\n", 1);
  if (!firstLine.endsWith(".")) return false;

  const filePath = firstLine.slice(
    FAILED_SOURCE_MAP_PREFIX.length,
    -".".length,
  );
  const normalizedMessage = normalizePath(message);

  return (
    isDependencyFile(filePath, "typescript") &&
    normalizePath(filePath).endsWith("/typescript/lib/typescript.js") &&
    normalizedMessage.includes(
      "An error occurred while trying to read the map file at typescript.js.map",
    ) &&
    normalizedMessage.includes("ENOENT:") &&
    normalizedMessage.includes("/typescript/lib/typescript.js.map")
  );
}

export function isKnownDependencyMissingSourcemapWarning(
  message: string,
): boolean {
  return (
    isKnownMissingSourcesWarning(message) ||
    isKnownMissingTypeScriptMapWarning(message)
  );
}

export function createDependencySourcemapFilteringLogger(
  logger: Logger = createLogger(),
): Logger {
  if (filteredLoggers.has(logger)) return logger;

  const warn = logger.warn.bind(logger);
  const warnOnce = logger.warnOnce.bind(logger);

  logger.warn = (message, options) => {
    if (!isKnownDependencyMissingSourcemapWarning(message)) {
      warn(message, options);
    }
  };
  logger.warnOnce = (message, options) => {
    if (!isKnownDependencyMissingSourcemapWarning(message)) {
      warnOnce(message, options);
    }
  };
  filteredLoggers.add(logger);

  return logger;
}

export function dependencySourcemapLoggerPlugin(): Plugin {
  return {
    name: "eliza-known-dependency-sourcemap-log-filter",
    enforce: "pre",
    configResolved(config) {
      createDependencySourcemapFilteringLogger(config.logger);
    },
  };
}
