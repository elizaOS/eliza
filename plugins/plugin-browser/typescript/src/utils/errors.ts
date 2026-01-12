import { logger } from "@elizaos/core";

export type ErrorCode =
  | "SERVICE_NOT_AVAILABLE"
  | "SESSION_ERROR"
  | "NAVIGATION_ERROR"
  | "ACTION_ERROR"
  | "SECURITY_ERROR"
  | "CAPTCHA_ERROR"
  | "TIMEOUT_ERROR"
  | "NO_URL_FOUND";

export class BrowserError extends Error {
  public readonly code: ErrorCode;
  public readonly userMessage: string;
  public readonly recoverable: boolean;
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: ErrorCode,
    userMessage: string,
    recoverable: boolean = true,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "BrowserError";
    this.code = code;
    this.userMessage = userMessage;
    this.recoverable = recoverable;
    this.details = details;
  }
}

export class ServiceNotAvailableError extends BrowserError {
  constructor() {
    super(
      "Browser service is not available",
      "SERVICE_NOT_AVAILABLE",
      "The browser automation service is not available. Please ensure the plugin is properly configured.",
      false
    );
  }
}

export class SessionError extends BrowserError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(
      message,
      "SESSION_ERROR",
      "There was an error with the browser session. Please try again.",
      true,
      details
    );
  }
}

export class NavigationError extends BrowserError {
  constructor(url: string, originalError?: Error) {
    const message = originalError
      ? `Failed to navigate to ${url}: ${originalError.message}`
      : `Failed to navigate to ${url}`;

    super(
      message,
      "NAVIGATION_ERROR",
      "I couldn't navigate to the requested page. Please check the URL and try again.",
      true,
      { url, originalError: originalError?.message }
    );
  }
}

export class ActionError extends BrowserError {
  constructor(action: string, target: string, originalError?: Error) {
    const message = originalError
      ? `Failed to ${action} on ${target}: ${originalError.message}`
      : `Failed to ${action} on ${target}`;

    super(
      message,
      "ACTION_ERROR",
      `I couldn't ${action} on the requested element. Please check if the element exists and try again.`,
      true,
      { action, target, originalError: originalError?.message }
    );
  }
}

export class SecurityError extends BrowserError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(
      message,
      "SECURITY_ERROR",
      "This action was blocked for security reasons.",
      false,
      details
    );
  }
}

export class CaptchaError extends BrowserError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(
      message,
      "CAPTCHA_ERROR",
      "Failed to solve the CAPTCHA. Please try again.",
      true,
      details
    );
  }
}

export class TimeoutError extends BrowserError {
  constructor(operation: string, timeoutMs: number) {
    super(
      `${operation} timed out after ${timeoutMs}ms`,
      "TIMEOUT_ERROR",
      `The operation timed out. Please try again.`,
      true,
      { operation, timeoutMs }
    );
  }
}

export class NoUrlFoundError extends BrowserError {
  constructor() {
    super(
      "No URL found in message",
      "NO_URL_FOUND",
      "I couldn't find a URL in your request. Please provide a valid URL to navigate to.",
      false
    );
  }
}

export function handleBrowserError(
  error: Error | BrowserError,
  callback?: (content: { text: string; error?: boolean }) => Promise<unknown>,
  action?: string
): void {
  if (error instanceof BrowserError) {
    logger.error(`Browser error [${error.code}]:`, error.message);
    void callback?.({
      text: error.userMessage,
      error: true,
    });
  } else {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Unexpected browser error: ${errorMessage}`);
    void callback?.({
      text: action
        ? `I encountered an error while trying to ${action}. Please try again.`
        : "I encountered an unexpected error. Please try again.",
      error: true,
    });
  }
}
