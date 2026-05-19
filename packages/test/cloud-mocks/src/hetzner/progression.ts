import type { HetznerStore } from "./store";
import type { MockAction, MockServer } from "./types";

export interface ProgressionOptions {
  /** Milliseconds before an action flips from `running` to `success`. */
  actionMs: number;
}

export function createAction(
  store: HetznerStore,
  command: string,
  resources: Array<{ id: number; type: string }>,
): MockAction {
  const id = store.allocActionId();
  const action: MockAction = {
    id,
    command,
    status: "running",
    progress: 0,
    started: new Date().toISOString(),
    finished: null,
    resources,
    error: null,
  };
  store.actions.set(id, action);
  return action;
}

export function scheduleActionSuccess(
  store: HetznerStore,
  actionId: number,
  options: ProgressionOptions,
  onComplete?: () => void,
): void {
  const ms = readActionMs(options.actionMs);
  const timer = setTimeout(() => {
    const action = store.actions.get(actionId);
    if (!action) return;
    action.status = "success";
    action.progress = 100;
    action.finished = new Date().toISOString();
    onComplete?.();
  }, ms);
  // Allow process exit even if timers are pending.
  if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

export function scheduleServerCreationProgression(
  store: HetznerStore,
  server: MockServer,
  actionId: number,
  options: ProgressionOptions,
): void {
  scheduleActionSuccess(store, actionId, options, () => {
    const current = store.servers.get(server.id);
    if (!current) return;
    current.status = "running";
  });
}

export function scheduleServerDeletion(
  store: HetznerStore,
  serverId: number,
  actionId: number,
  options: ProgressionOptions,
): void {
  scheduleActionSuccess(store, actionId, options, () => {
    store.servers.delete(serverId);
  });
}

export function schedulePowerTransition(
  store: HetznerStore,
  serverId: number,
  actionId: number,
  targetStatus: MockServer["status"],
  options: ProgressionOptions,
): void {
  scheduleActionSuccess(store, actionId, options, () => {
    const current = store.servers.get(serverId);
    if (!current) return;
    current.status = targetStatus;
  });
}

function readActionMs(fallback: number): number {
  const fromEnv = process.env.MOCK_HETZNER_ACTION_MS;
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return fallback;
}
