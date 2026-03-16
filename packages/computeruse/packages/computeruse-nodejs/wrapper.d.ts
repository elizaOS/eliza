// Re-export everything from the native bindings
export * from "./index";

// Explicit exports for type-only consumers when ./index has no .d.ts (e.g. before native build)
export const Desktop: new (useBackgroundApps?: boolean, activateApp?: boolean) => import("./index").Desktop;
export const Element: new (...args: unknown[]) => import("./index").Element;
export const Locator: new (...args: unknown[]) => import("./index").Locator;
export const Selector: new (...args: unknown[]) => import("./index").Selector;
export const WindowManager: new (...args: unknown[]) => import("./index").WindowManager;

/** Thrown when an element is not found. */
export class ElementNotFoundError extends Error {
  constructor(message: string);
}

/** Thrown when an operation times out. */
export class TimeoutError extends Error {
  constructor(message: string);
}

/** Thrown when permission is denied. */
export class PermissionDeniedError extends Error {
  constructor(message: string);
}

/** Thrown for platform-specific errors. */
export class PlatformError extends Error {
  constructor(message: string);
}

/** Thrown for unsupported operations. */
export class UnsupportedOperationError extends Error {
  constructor(message: string);
}

/** Thrown for unsupported platforms. */
export class UnsupportedPlatformError extends Error {
  constructor(message: string);
}

/** Thrown for invalid arguments. */
export class InvalidArgumentError extends Error {
  constructor(message: string);
}

/** Thrown for internal errors. */
export class InternalError extends Error {
  constructor(message: string);
}

// Browser script execution types
export type BrowserScriptEnv = Record<string, unknown>;
export type BrowserScriptFunction<
  T = unknown,
  Env extends BrowserScriptEnv = BrowserScriptEnv,
> = (env: Env) => T | Promise<T>;
export interface BrowserScriptOptions<
  Env extends BrowserScriptEnv = BrowserScriptEnv,
> {
  file: string;
  env?: Env;
}

// Augment Desktop class with browser script methods
declare module "./index.d" {
  interface Desktop {
    executeBrowserScript<
      T = unknown,
      Env extends BrowserScriptEnv = BrowserScriptEnv,
    >(
      fn: BrowserScriptFunction<T, Env>,
      env?: Env,
    ): Promise<T>;
    executeBrowserScript<Env extends BrowserScriptEnv = BrowserScriptEnv>(
      options: BrowserScriptOptions<Env>,
    ): Promise<string>;
  }

  interface Element {
    executeBrowserScript<
      T = unknown,
      Env extends BrowserScriptEnv = BrowserScriptEnv,
    >(
      fn: BrowserScriptFunction<T, Env>,
      env?: Env,
    ): Promise<T>;
    executeBrowserScript<Env extends BrowserScriptEnv = BrowserScriptEnv>(
      options: BrowserScriptOptions<Env>,
    ): Promise<string>;
  }
}
