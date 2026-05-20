import * as Sentry from "@sentry/nextjs";

const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|authorization|cookie|jwt|api[-_]?key|signature|session|credential|wallet|private[-_]?key)/i;

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (depth >= 2) {
    if (Array.isArray(value)) {
      return `[array:${value.length}]`;
    }
    if (typeof value === "object") {
      return "[object]";
    }
  }

  if (typeof value === "string") {
    return `[string:${value.length}]`;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "function" || typeof value === "symbol") {
    return `[${typeof value}]`;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 5).map((entry) => sanitizeValue(entry, depth + 1));
  }

  const objectValue = value as Record<string, unknown>;
  const entries = Object.entries(objectValue).slice(0, 10);
  const out: Record<string, unknown> = {};

  for (const [key, entryValue] of entries) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    out[key] = sanitizeValue(entryValue, depth + 1);
  }

  return out;
}

function sanitizeActionArgs(args: unknown[]): Record<string, unknown> {
  return {
    argCount: args.length,
    args: sanitizeValue(args),
  };
}

/**
 * Wrap a server action with Sentry performance + exception instrumentation.
 * Argument metadata is sanitized to avoid leaking secrets/PII.
 *
 * On error: enriches the active Sentry scope with action context, then rethrows.
 * The actual exception capture is delegated to Next.js's onRequestError hook
 * (instrumentation.ts: `export const onRequestError = Sentry.captureRequestError`)
 * to avoid double-counting the same error event.
 */
export function wrapServerActionWithSentry<T extends unknown[], R>(
  actionName: string,
  action: (...args: T) => Promise<R>,
): (...args: T) => Promise<R> {
  return async (...args: T): Promise<R> => {
    return Sentry.startSpan(
      {
        op: "server.action",
        name: `server-action.${actionName}`,
        attributes: {
          "feed.surface": "server-action",
          "feed.action": actionName,
        },
      },
      async () => {
        try {
          return await action(...args);
        } catch (error) {
          Sentry.setTag("runtime", "nodejs");
          Sentry.setTag("surface", "server-action");
          Sentry.setTag("action", actionName);
          Sentry.setContext("serverAction", sanitizeActionArgs(args));
          throw error;
        }
      },
    );
  };
}
