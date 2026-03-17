// Re-export everything from the native bindings
export * from "./index";

/** Element returned by locator().first(); has click and typeText. */
export interface DesktopElement {
  click(): Promise<void>;
  typeText(text: string, options?: { clearBeforeTyping?: boolean }): Promise<void>;
}

/** Locator chain; .first() returns the element. */
export interface DesktopLocator {
  first(timeoutMs: number): Promise<DesktopElement | null>;
}

/** App entry from applications(). */
export interface DesktopApplication {
  name(): string;
}

/** Desktop automation class (wrapped native binding). */
export const Desktop: new (useBackgroundApps?: boolean, activateApp?: boolean) => {
  locator(selector: string): DesktopLocator;
  openApplication(appName: string): void;
  getWindowTree(process: string, title?: string, ...args: unknown[]): unknown;
  applications(): DesktopApplication[];
  [key: string]: unknown;
};

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
