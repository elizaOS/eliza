import type {
  HandlerOptions,
  Memory,
} from "@elizaos/core";

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
