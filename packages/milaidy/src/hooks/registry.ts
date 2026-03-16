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

  for (const { key, handler } of handlers) {
    try {
      await handler(event);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[hooks] Handler error for "${key}": ${msg}`);
    }
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
