import * as native from "./index.js";
import * as util from "util";
import * as fs from "fs";
import * as path from "path";

// Type definitions for native classes
type NativeClass =
  | typeof native.Desktop
  | typeof native.Element
  | typeof native.Locator
  | typeof native.Selector;

function patchInspector(
  Klass: any,
  methodName = "toString",
  forcePlainObject = false,
): void {
  if (!Klass || typeof Klass !== "function") {
    console.log("inspect not a function");
    return;
  }
  const proto = Klass.prototype;
  const original = proto[util.inspect.custom];
  proto[util.inspect.custom] = function (...args: any[]) {
    if (typeof this[methodName] === "function") {
      const result = this[methodName](...args);
      if (forcePlainObject && result && typeof result === "object") {
        return { ...result };
      }
      return result;
    }
    if (typeof original === "function") {
      return original.apply(this, args);
    }
    return { ...this };
  };
}

function wrapNativeFunction<T extends Function>(fn: T): T {
  if (typeof fn !== "function") return fn;
  return function (this: any, ...args: any[]) {
    try {
      const result = fn.apply(this, args);
      if (result instanceof Promise) {
        return result.catch((error) => {
          throw mapNativeError(error);
        });
      }
      return result;
    } catch (error) {
      throw mapNativeError(error);
    }
  } as any;
}

function wrapClassMethods<T extends NativeClass>(Class: T): T {
  const prototype = Class.prototype;
  const methods = Object.getOwnPropertyNames(prototype);
  methods.forEach((method) => {
    if (method !== "constructor" && typeof prototype[method] === "function") {
      prototype[method] = wrapNativeFunction(prototype[method]);
    }
  });
  return Class;
}

function wrapClass<T extends NativeClass>(
  Class: T,
  ...inspectOptions: any[]
): T {
  const Wrapped = wrapClassMethods(Class);
  patchInspector(Wrapped, ...(inspectOptions || []));
  return Wrapped;
}

// Custom error classes
export class ElementNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElementNotFoundError";
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

export class PlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformError";
  }
}

export class UnsupportedOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedOperationError";
  }
}

export class UnsupportedPlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedPlatformError";
  }
}

export class InvalidArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidArgumentError";
  }
}

export class InternalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InternalError";
  }
}

// Error mapping function
function mapNativeError(error: any): Error {
  if (!error.message) return error;

  const message = error.message;
  if (message.startsWith("ELEMENT_NOT_FOUND:")) {
    return new ElementNotFoundError(
      message.replace("ELEMENT_NOT_FOUND:", "").trim(),
    );
  }
  if (message.startsWith("OPERATION_TIMED_OUT:")) {
    return new TimeoutError(message.replace("OPERATION_TIMED_OUT:", "").trim());
  }
  if (message.startsWith("PERMISSION_DENIED:")) {
    return new PermissionDeniedError(
      message.replace("PERMISSION_DENIED:", "").trim(),
    );
  }
  if (message.startsWith("PLATFORM_ERROR:")) {
    return new PlatformError(message.replace("PLATFORM_ERROR:", "").trim());
  }
  if (message.startsWith("UNSUPPORTED_OPERATION:")) {
    return new UnsupportedOperationError(
      message.replace("UNSUPPORTED_OPERATION:", "").trim(),
    );
  }
  if (message.startsWith("UNSUPPORTED_PLATFORM:")) {
    return new UnsupportedPlatformError(
      message.replace("UNSUPPORTED_PLATFORM:", "").trim(),
    );
  }
  if (message.startsWith("INVALID_ARGUMENT:")) {
    return new InvalidArgumentError(
      message.replace("INVALID_ARGUMENT:", "").trim(),
    );
  }
  if (message.startsWith("INTERNAL_ERROR:")) {
    return new InternalError(message.replace("INTERNAL_ERROR:", "").trim());
  }
  return error;
}

// Types for executeBrowserScript arguments
export type BrowserScriptEnv = Record<string, unknown>;
export type BrowserScriptFunction = (env?: BrowserScriptEnv) => any;
export type BrowserScriptOptions = {
  file: string;
  env?: BrowserScriptEnv;
};
type BrowserScriptInput = string | BrowserScriptFunction | BrowserScriptOptions;

// Enhanced executeBrowserScript with function and file support
// Desktop signature: (script, process, timeoutMs?)
// Element signature: (script)
async function enhancedExecuteBrowserScript(
  this: any,
  scriptOrFunction: BrowserScriptInput,
  processOrEnv?: string | any,
  timeoutMs?: number,
): Promise<any> {
  // Detect if this is Desktop or Element
  // Can't use .length on napi functions (always returns 0), so check constructor name
  const isDesktop = this.constructor?.name === 'Desktop';

  // For Desktop: second param is process name, third is timeout
  // For Element: second param is env options (backward compatible)
  let process: string | undefined;
  let envOrOptions: any;

  if (isDesktop) {
    if (typeof processOrEnv !== 'string') {
      throw new Error(
        "Desktop.executeBrowserScript requires 'process' as second argument (e.g., 'chrome', 'msedge', 'firefox'). " +
        "Usage: desktop.executeBrowserScript(script, 'chrome', timeoutMs?)"
      );
    }
    process = processOrEnv;
  } else {
    // Element - second param is env options
    envOrOptions = processOrEnv;
  }
  let script: string;
  let env: any = {};
  let shouldInjectEnv = false; // Only inject env for file-based and string scripts, not functions

  // Handle different input types
  if (typeof scriptOrFunction === "string") {
    // Check if it's a file path
    if (scriptOrFunction.endsWith(".ts") || scriptOrFunction.endsWith(".js")) {
      // File path - read and compile
      const filePath = path.resolve(scriptOrFunction);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Browser script file not found: ${filePath}`);
      }

      let fileContent = fs.readFileSync(filePath, "utf-8");

      // If TypeScript, compile it
      if (filePath.endsWith(".ts")) {
        try {
          const esbuild = require("esbuild");
          const result = await esbuild.transform(fileContent, {
            loader: "ts",
            target: "es2020",
            format: "iife",
          });
          fileContent = result.code;
        } catch (e: any) {
          // If esbuild not available, try to use as-is (may work for simple TS)
          console.warn(
            "esbuild not found - using TypeScript file as-is:",
            e.message,
          );
        }
      }

      script = fileContent;
      env = envOrOptions || {};
      shouldInjectEnv = true; // Inject env for file paths passed as strings
    } else {
      // Plain string script - use as-is (backward compatible)
      script = scriptOrFunction;
    }
  } else if (typeof scriptOrFunction === "function") {
    // Function - convert to IIFE with proper wrapping
    const funcString = scriptOrFunction.toString();
    env = envOrOptions || {};

    // Wrap function in IIFE that handles return values
    script = `
      (async function() {
        const fn = ${funcString};
        const result = await fn(${JSON.stringify(env)});

        // Auto-stringify result if it's an object
        if (result !== undefined && result !== null) {
          if (typeof result === 'object') {
            return JSON.stringify(result);
          }
          return String(result);
        }
        return "undefined";
      })()
    `;
  } else if (
    typeof scriptOrFunction === "object" &&
    (scriptOrFunction as BrowserScriptOptions).file
  ) {
    // Object with file property
    const options = scriptOrFunction as BrowserScriptOptions;
    const filePath = path.resolve(options.file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Browser script file not found: ${filePath}`);
    }

    let fileContent = fs.readFileSync(filePath, "utf-8");

    // If TypeScript, compile it
    if (filePath.endsWith(".ts")) {
      try {
        const esbuild = require("esbuild");
        const result = await esbuild.transform(fileContent, {
          loader: "ts",
          target: "es2020",
          format: "iife",
        });
        fileContent = result.code;
      } catch (e: any) {
        console.warn(
          "esbuild not found - using TypeScript file as-is:",
          e.message,
        );
      }
    }

    script = fileContent;
    env = options.env || {};
    shouldInjectEnv = true; // Inject env for file option objects
  } else {
    throw new Error(
      "Invalid argument to executeBrowserScript: expected string, function, or {file, env} object",
    );
  }

  // If env variables are provided and we should inject them (file-based scripts only)
  if (shouldInjectEnv && env && Object.keys(env).length > 0) {
    // Inject as an env object that scripts can access
    const envObject = `const env = ${JSON.stringify(env)};`;
    script = `${envObject}\n${script}`;
  }

  // Call the original native method
  // Desktop requires (script, process, timeoutMs?), Element only needs (script)
  const resultStr = isDesktop
    ? await this._originalExecuteBrowserScript(script, process, timeoutMs)
    : await this._originalExecuteBrowserScript(script);

  // If function was passed, try to parse JSON result
  if (typeof scriptOrFunction === "function") {
    try {
      return JSON.parse(resultStr);
    } catch (e) {
      // Not JSON, return as-is
      return resultStr;
    }
  }

  // For string/file, return raw result (backward compatible)
  return resultStr;
}

// Wrap the native classes
export const Desktop = wrapClassMethods(native.Desktop);
export const Element = wrapClass(native.Element);
export const Locator = wrapClass(native.Locator);
export const Selector = wrapClass(native.Selector);
export const WindowManager = wrapClassMethods(native.WindowManager);

// Patch executeBrowserScript on Desktop and Element
if (Desktop.prototype.executeBrowserScript) {
  (Desktop.prototype as any)._originalExecuteBrowserScript =
    Desktop.prototype.executeBrowserScript;
  Desktop.prototype.executeBrowserScript = enhancedExecuteBrowserScript;
}

if (Element.prototype.executeBrowserScript) {
  (Element.prototype as any)._originalExecuteBrowserScript =
    Element.prototype.executeBrowserScript;
  Element.prototype.executeBrowserScript = enhancedExecuteBrowserScript;
}

// Re-export native types
export type {
  ValidationResult,
  Bounds,
  Coordinates,
  ClickResult,
  CommandOutput,
  Monitor,
  MonitorScreenshotPair,
  ScreenshotResult,
  UIElementAttributes,
  UINode,
  WindowInfo,
  ActionOptions,
  TypeTextOptions,
  PressKeyOptions,
  // Computer Use types
  ComputerUseResult,
  ComputerUseStep,
  ComputerUsePendingConfirmation,
} from "./index.js";
export {
  ClickType,
  ClusteredBoundsEntry,
  ClusteredFormattingResult,
  ElementSource,
  PropertyLoadingMode,
  TextPosition,
  TreeOutputFormat,
  VisionType,
} from "./index.js";
