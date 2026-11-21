export const COMMIT_GRANT_MAX_MS: number;
export const COMMIT_PATTERN_MAX_LENGTH: number;

export interface TaskBindingPorts {
  bindings: Map<string, unknown>;
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
  clearGuidance(id: string): Promise<void>;
  getUrl(id: string): Promise<string>;
  validTabId(id: unknown): boolean;
  now?: () => number;
}

export interface TaskBindings {
  bind(message: unknown, current: () => boolean): Promise<{ bound: boolean; bindingRevision: number; tabId: string; taskId: string; epoch: number }>;
  scope(command: unknown, cleanup?: boolean): Promise<{ command: Record<string, unknown>; current: () => boolean }>;
  blocked(): Error;
  validId(value: unknown): boolean;
  liveBinding(id: string): unknown;
  settled(id: string): Promise<void>;
}

export function createTaskBindings(ports: TaskBindingPorts): TaskBindings;
