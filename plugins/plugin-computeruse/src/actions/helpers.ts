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
    sanitized[key] = value;
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
  return {
    success: result.success,
    text,
    ...(result.success ? {} : { error: result.error ?? "Computer-use failed" }),
    data: {
      source: "computeruse",
      computerUseAction: action,
      result: sanitizeNativeResult(result),
      ...(suppressClipboard ? { suppressActionResultClipboard: true } : {}),
    },
  };
}
