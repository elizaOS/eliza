type DebugLogger = ((...args: unknown[]) => void) & {
  destroy: () => void;
  enabled: boolean;
  extend: (namespace: string, delimiter?: string) => DebugLogger;
  namespace: string;
};

type DebugFactory = ((namespace: string) => DebugLogger) & {
  coerce: (value: unknown) => unknown;
  colors: string[];
  debug: DebugFactory;
  default: DebugFactory;
  disable: () => string;
  enable: (namespaces: string) => void;
  enabled: (namespace: string) => boolean;
  formatters: Record<string, (value: unknown) => unknown>;
  names: RegExp[];
  skips: RegExp[];
};

let enabledNamespaces = "";

function compilePattern(pattern: string): RegExp {
  return new RegExp(
    `^${pattern
      .trim()
      .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
      .replace(/\*/g, ".*?")}$`,
  );
}

function isSkipPattern(pattern: string): boolean {
  return pattern.startsWith("!") || pattern.startsWith("-");
}

function skipPatternBody(pattern: string): string {
  return isSkipPattern(pattern) ? pattern.slice(1) : pattern;
}

function compilePatterns(value: string, inverted: boolean): RegExp[] {
  return value
    .split(/[\s,]+/)
    .filter((pattern) =>
      inverted ? isSkipPattern(pattern) : pattern && !isSkipPattern(pattern),
    )
    .map((pattern) => compilePattern(skipPatternBody(pattern)));
}

function coerce(value: unknown): unknown {
  return value instanceof Error ? value.stack || value.message : value;
}

const debug = ((namespace: string): DebugLogger => {
  const logger = ((...args: unknown[]) => {
    if (logger.enabled) {
      globalThis.console?.debug?.(namespace, ...args.map(coerce));
    }
  }) as DebugLogger;

  Object.defineProperty(logger, "enabled", {
    configurable: true,
    get: () => debug.enabled(namespace),
  });
  logger.destroy = () => {};
  logger.extend = (childNamespace, delimiter = ":") =>
    debug(`${namespace}${delimiter}${childNamespace}`);
  logger.namespace = namespace;
  return logger;
}) as DebugFactory;

debug.colors = [];
debug.formatters = {};
debug.names = [];
debug.skips = [];
debug.coerce = coerce;
debug.disable = () => {
  const previous = enabledNamespaces;
  debug.enable("");
  try {
    globalThis.localStorage?.removeItem("debug");
  } catch {
    // localStorage can be unavailable in sandboxed browser contexts.
  }
  return previous;
};
debug.enable = (namespaces: string) => {
  enabledNamespaces = namespaces;
  debug.names = compilePatterns(namespaces, false);
  debug.skips = compilePatterns(namespaces, true);
  try {
    if (namespaces) {
      globalThis.localStorage?.setItem("debug", namespaces);
    } else {
      globalThis.localStorage?.removeItem("debug");
    }
  } catch {
    // localStorage can be unavailable in sandboxed browser contexts.
  }
};
debug.enabled = (namespace: string) => {
  if (debug.skips.some((pattern) => pattern.test(namespace))) return false;
  return debug.names.some((pattern) => pattern.test(namespace));
};
debug.debug = debug;
debug.default = debug;

try {
  debug.enable(globalThis.localStorage?.getItem("debug") ?? "");
} catch {
  debug.enable("");
}

export const colors = debug.colors;
export const formatters = debug.formatters;
export const disable = debug.disable;
export const enable = debug.enable;
export const enabled = debug.enabled;
export { debug };
export default debug;
