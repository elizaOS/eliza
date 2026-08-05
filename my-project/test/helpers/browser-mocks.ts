const CONSOLE_PATCH_MARK = Symbol.for("eliza.test.consoleErrorPatched");
const CONSOLE_WARN_PATCH_MARK = Symbol.for("eliza.test.consoleWarnPatched");
const CONSOLE_LOG_PATCH_MARK = Symbol.for("eliza.test.consoleLogPatched");

export function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
    get length() {
      return store.size;
    },
    key(index: number) {
      return [...store.keys()][index] ?? null;
    },
  } as Storage;
}

export function hasStorageApi(value: unknown): value is Storage {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as Storage).getItem === "function" &&
      typeof (value as Storage).setItem === "function" &&
      typeof (value as Storage).removeItem === "function" &&
      typeof (value as Storage).clear === "function",
  );
}

export function suppressReactTestConsoleErrors(): void {
  const currentConsoleError = console.error as typeof console.error & {
    [CONSOLE_PATCH_MARK]?: boolean;
  };
  if (!currentConsoleError[CONSOLE_PATCH_MARK]) {
    const originalConsoleError = console.error.bind(console);
    const patchedConsoleError = ((...args: unknown[]) => {
      const first = args[0];
      if (
        typeof first === "string" &&
        (first.includes("react-test-renderer is deprecated") ||
          first.includes(
            "The current testing environment is not configured to support act(...)",
          ) ||
          first.includes("was not wrapped in act(...)"))
      ) {
        return;
      }
      originalConsoleError(...args);
    }) as typeof console.error & {
      [CONSOLE_PATCH_MARK]?: boolean;
    };
    patchedConsoleError[CONSOLE_PATCH_MARK] = true;
    console.error = patchedConsoleError;
  }

  const currentConsoleWarn = console.warn as typeof console.warn & {
    [CONSOLE_WARN_PATCH_MARK]?: boolean;
  };
  if (!currentConsoleWarn[CONSOLE_WARN_PATCH_MARK]) {
    const originalConsoleWarn = console.warn.bind(console);
    const patchedConsoleWarn = ((...args: unknown[]) => {
      const first = args[0];
      if (
        typeof first === "string" &&
        (first.includes("[openExternalUrl]") ||
          first.includes("[RenderGuard]") ||
          first.includes("[persistence] localStorage operation failed:") ||
          first.includes(
            "[Gateway] mDNS discovery not available - desktop bridge not configured",
          ))
      ) {
        return;
      }
      originalConsoleWarn(...args);
    }) as typeof console.warn & {
      [CONSOLE_WARN_PATCH_MARK]?: boolean;
    };
    patchedConsoleWarn[CONSOLE_WARN_PATCH_MARK] = true;
    console.warn = patchedConsoleWarn;
  }

  const currentConsoleLog = console.log as typeof console.log & {
    [CONSOLE_LOG_PATCH_MARK]?: boolean;
  };
  if (!currentConsoleLog[CONSOLE_LOG_PATCH_MARK]) {
    const originalConsoleLog = console.log.bind(console);
    const patchedConsoleLog = ((...args: unknown[]) => {
      const first = args[0];
      if (
        typeof first === "string" &&
        first.includes("[shell] switchShellView:")
      ) {
        return;
      }
      originalConsoleLog(...args);
    }) as typeof console.log & {
      [CONSOLE_LOG_PATCH_MARK]?: boolean;
    };
    patchedConsoleLog[CONSOLE_LOG_PATCH_MARK] = true;
    console.log = patchedConsoleLog;
  }
}
