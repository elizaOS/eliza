import type { ActionResult, HandlerOptions, Memory } from "@elizaos/core";

export interface NativeComputerUseResult {
  success: boolean;
  message?: string;
  error?: string;
  permissionDenied?: boolean;
  permissionType?: string;
  approvalRequired?: boolean;
  approvalId?: string;
  screenshot?: string;
  frontendScreenshot?: string;
}

const MAX_COMPUTER_USE_TEXT_LENGTH = 4000;
const MAX_COMPUTER_USE_ITEMS = 50;
const MAX_COMPUTER_USE_OBJECT_KEYS = 80;

function truncateText(value: string, maxLength = MAX_COMPUTER_USE_TEXT_LENGTH): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}... [truncated]` : value;
}

function capNativeValue(value: unknown): unknown {
  if (typeof value === "string") return truncateText(value);
  if (Array.isArray(value)) return value.slice(0, MAX_COMPUTER_USE_ITEMS).map(capNativeValue);
  if (value && typeof value === "object") {
    const capped: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_COMPUTER_USE_OBJECT_KEYS)) {
      capped[key] = capNativeValue(item);
    }
    return capped;
  }
  return value;
}

export function resolveActionParams<T>(
  message: Memory,
  options?: HandlerOptions,
): T {
  const params = {
    ...(((options as Record<string, unknown> | undefined)?.parameters ??
      {}) as Record<string, unknown>),
  };

  if (message.content && typeof message.content === "object") {
    for (const [key, value] of Object.entries(
      message.content as Record<string, unknown>,
    )) {
      if (params[key] === undefined) {
        params[key] = value;
      }
    }
  }

  return params as T;
}

export function buildScreenshotAttachment(args: {
  idPrefix: string;
  screenshot: string;
  title: string;
  description: string;
}) {
  return {
    id: `${args.idPrefix}-${Date.now()}`,
    url: `data:image/png;base64,${args.screenshot}`,
    title: args.title,
    source: "computeruse",
    description: args.description,
    contentType: "image" as const,
  };
}

function sanitizeNativeResult<T extends NativeComputerUseResult>(
  result: T,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    if (key === "screenshot") {
      sanitized.hasScreenshot = typeof value === "string" && value.length > 0;
      continue;
    }
    if (key === "frontendScreenshot") {
      sanitized.hasFrontendScreenshot =
        typeof value === "string" && value.length > 0;
      continue;
    }
    sanitized[key] = capNativeValue(value);
  }
  return sanitized;
}

export function toComputerUseActionResult<T extends NativeComputerUseResult>({
  action,
  result,
  text,
  suppressClipboard = false,
}: {
  action: string;
  result: T;
  text: string;
  suppressClipboard?: boolean;
}): ActionResult {
  const cappedText = truncateText(text);
  return {
    success: result.success,
    text: cappedText,
    ...(result.success ? {} : { error: result.error ?? "Computer-use failed" }),
    data: {
      source: "computeruse",
      computerUseAction: action,
      maxTextLength: MAX_COMPUTER_USE_TEXT_LENGTH,
      maxItems: MAX_COMPUTER_USE_ITEMS,
      result: sanitizeNativeResult(result),
      ...(suppressClipboard ? { suppressActionResultClipboard: true } : {}),
    },
  };
}
