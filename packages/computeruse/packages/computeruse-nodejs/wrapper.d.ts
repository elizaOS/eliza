// Re-export everything from the native bindings
export * from "./index";

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
