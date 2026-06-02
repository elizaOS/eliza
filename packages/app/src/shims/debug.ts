type DebugLogger = ((...args: unknown[]) => void) & {
  namespace: string;
  enabled: boolean;
  extend: (namespace: string, delimiter?: string) => DebugLogger;
  destroy: () => void;
};

type DebugFactory = ((namespace: string) => DebugLogger) & {
  debug: DebugFactory;
  default: DebugFactory;
  coerce: (value: unknown) => unknown;
  disable: () => string;
  enable: (namespaces: string) => void;
  enabled: (namespace: string) => boolean;
  humanize: (milliseconds: number) => string;
  destroy: () => void;
  names: string[];
  namespaces: string;
  skips: string[];
  formatters: Record<string, (value: unknown) => string>;
};

let enabledNamespaces = "";

function matches(namespace: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replace(/\*/g, ".*?");
  return new RegExp(`^${escaped}$`).test(namespace);
}

function parseNamespaces(namespaces: string): {
  names: string[];
  skips: string[];
} {
  const parts = namespaces
    .trim()
    .replace(/\s+/g, ",")
    .split(",")
    .filter(Boolean);

  return {
    names: parts.filter((part) => !part.startsWith("-")),
    skips: parts
      .filter((part) => part.startsWith("-"))
      .map((part) => part.slice(1)),
  };
}

function humanize(milliseconds: number): string {
  if (milliseconds >= 1000) return `${Math.round(milliseconds / 1000)}s`;
  return `${Math.round(milliseconds)}ms`;
}

const createDebug = ((namespace: string): DebugLogger => {
  const logger = ((...args: unknown[]) => {
    if (logger.enabled && typeof console !== "undefined") {
      console.debug(namespace, ...args);
    }
  }) as DebugLogger;

  logger.namespace = namespace;
  logger.enabled = createDebug.enabled(namespace);
  logger.extend = (childNamespace, delimiter = ":") => {
    return createDebug(`${namespace}${delimiter}${childNamespace}`);
  };
  logger.destroy = () => {};

  return logger;
}) as DebugFactory;

createDebug.debug = createDebug;
createDebug.default = createDebug;
createDebug.coerce = (value) => value;
createDebug.disable = () => {
  const previous = enabledNamespaces;
  createDebug.enable("");
  return previous;
};
createDebug.enable = (namespaces) => {
  enabledNamespaces = namespaces;
  createDebug.namespaces = namespaces;
  const parsed = parseNamespaces(namespaces);
  createDebug.names = parsed.names;
  createDebug.skips = parsed.skips;
};
createDebug.enabled = (namespace) => {
  for (const skip of createDebug.skips) {
    if (matches(namespace, skip)) return false;
  }
  for (const name of createDebug.names) {
    if (matches(namespace, name)) return true;
  }
  return false;
};
createDebug.humanize = humanize;
createDebug.destroy = () => {};
createDebug.names = [];
createDebug.namespaces = "";
createDebug.skips = [];
createDebug.formatters = {};

export const debug = createDebug;
export const coerce = createDebug.coerce;
export const disable = createDebug.disable;
export const enable = createDebug.enable;
export const enabled = createDebug.enabled;
export const humanizeDebug = createDebug.humanize;
export default createDebug;
