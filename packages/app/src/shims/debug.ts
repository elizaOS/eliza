/**
 * Browser shim for the `debug` package: namespaced debug loggers gated by a
 * namespace filter. `createDebug(namespace)` returns a logger that emits to
 * `console.debug` only when its namespace is enabled; enablement is driven by
 * `enable`/`disable` and persisted in `localStorage["debug"]`, matched against
 * comma/space-separated namespaces with `*` wildcard and trailing-`*` prefix
 * support. Exposes the same statics (enable/disable/enabled/coerce) and the
 * default/named exports the real module provides.
 */
type DebugLogger = ((...args: unknown[]) => void) & {
  namespace: string;
  enabled: boolean;
  extend: (namespace: string, delimiter?: string) => DebugLogger;
};

const enabledNamespaces = new Set<string>();
let wildcardEnabled = false;

function refresh(namespaces: string | undefined): void {
  enabledNamespaces.clear();
  wildcardEnabled = false;

  for (const namespace of (namespaces ?? "").split(/[\s,]+/)) {
    if (!namespace || namespace.startsWith("-")) continue;
    if (namespace === "*") {
      wildcardEnabled = true;
    } else {
      enabledNamespaces.add(namespace);
    }
  }
}

export function enable(namespaces: string): void {
  refresh(namespaces);
  try {
    globalThis.localStorage?.setItem("debug", namespaces);
  } catch {
    // localStorage can be unavailable in sandboxed browser contexts.
  }
}

export function disable(): string {
  const namespaces = [...enabledNamespaces].join(",");
  refresh("");
  try {
    globalThis.localStorage?.removeItem("debug");
  } catch {
    // localStorage can be unavailable in sandboxed browser contexts.
  }
  return namespaces;
}

export function enabled(namespace: string): boolean {
  if (wildcardEnabled || enabledNamespaces.has(namespace)) return true;

  for (const enabledNamespace of enabledNamespaces) {
    if (
      enabledNamespace.endsWith("*") &&
      namespace.startsWith(enabledNamespace.slice(0, -1))
    ) {
      return true;
    }
  }

  return false;
}

export function coerce(value: unknown): unknown {
  return value instanceof Error ? value.stack || value.message : value;
}

function createDebug(namespace: string): DebugLogger {
  const logger = ((...args: unknown[]) => {
    if (!logger.enabled) return;
    globalThis.console?.debug?.(namespace, ...args);
  }) as DebugLogger;

  logger.namespace = namespace;
  logger.enabled = enabled(namespace);
  logger.extend = (childNamespace, delimiter = ":") =>
    createDebug(`${namespace}${delimiter}${childNamespace}`);

  return logger;
}

try {
  refresh(globalThis.localStorage?.getItem("debug") ?? "");
} catch {
  refresh("");
}

createDebug.enable = enable;
createDebug.disable = disable;
createDebug.enabled = enabled;
createDebug.coerce = coerce;
createDebug.debug = createDebug;
createDebug.default = createDebug;

export { createDebug as debug };
export default createDebug;
