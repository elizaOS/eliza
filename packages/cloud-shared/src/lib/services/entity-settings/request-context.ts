import { AsyncLocalStorage } from "node:async_hooks";
import type { UUID } from "@elizaos/core";

export type EntitySettingContextValue = string | boolean | number | null;

export interface EntitySettingsRequestContext {
  entityId?: UUID;
  agentId?: UUID;
  entitySettings: Map<string, EntitySettingContextValue>;
  requestStartTime?: number;
}

const requestContextStorage = new AsyncLocalStorage<EntitySettingsRequestContext>();

export function getRequestContext(): EntitySettingsRequestContext | undefined {
  return requestContextStorage.getStore();
}

export function runWithRequestContext<T>(
  context: EntitySettingsRequestContext,
  operation: () => Promise<T> | T,
): Promise<T> {
  return requestContextStorage.run(context, async () => await operation());
}
