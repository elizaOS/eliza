import { logger } from "@elizaos/core";
import type { HookEvent, HookHandler } from "./types.js";

const registry = new Map<string, HookHandler[]>();

/**
 * Event keys: "command" matches all command events,
 * "command:new" matches only /new.
 */
export function registerHook(eventKey: string, handler: HookHandler): void {
  const handlers = registry.get(eventKey) ?? [];
  handlers.push(handler);
  registry.set(eventKey, handlers);
}

export function clearHooks(): void {
  registry.clear();
}

/** Dispatches to specific ("command:new") then general ("command") handlers. */
export async function triggerHook(event: HookEvent): Promise<void> {
  const specificKey = `${event.type}:${event.action}`;
  const generalKey = event.type;

  const handlers: Array<{ key: string; handler: HookHandler }> = [];

  const specificHandlers = registry.get(specificKey);
  if (specificHandlers) {
    for (const handler of specificHandlers) {
      handlers.push({ key: specificKey, handler });
    }
  }

  const generalHandlers = registry.get(generalKey);
  if (generalHandlers) {
    for (const handler of generalHandlers) {
      handlers.push({ key: generalKey, handler });
    }
  }

  if (handlers.length === 0) return;

  const errors: Error[] = [];
  for (const { key, handler } of handlers) {
    try {
      await handler(event);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(`[hooks] Handler error for "${key}": ${error.message}`);
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    logger.warn(
      `[hooks] ${errors.length} hook handler(s) failed — errors were logged above`,
    );
  }
}

export function createHookEvent(
  type: HookEvent["type"],
  action: string,
  sessionKey: string,
  context: Record<string, unknown> = {},
): HookEvent {
  return {
    type,
    action,
    sessionKey,
    timestamp: new Date(),
    messages: [],
    context,
  };
}
