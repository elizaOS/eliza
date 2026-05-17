/**
 * Trigger (heartbeat) state — extracted from AppContext.
 *
 * Manages trigger CRUD, run history, and health polling. Zero coupling to
 * the startup sequence — triggers are only loaded post-ready.
 */
import type {
  CreateTriggerRequest,
  TriggerRunRecord,
  TriggerSummary,
  UpdateTriggerRequest,
} from "../api";
export declare function useTriggersState(): {
  state: {
    triggers: import("@elizaos/shared").TriggerSummary[];
    triggersLoaded: boolean;
    triggersLoading: boolean;
    triggersSaving: boolean;
    triggerRunsById: Record<string, TriggerRunRecord[]>;
    triggerHealth: import("@elizaos/shared").TriggerHealthSnapshot | null;
    triggerError: string | null;
  };
  loadTriggers: (options?: { silent?: boolean }) => Promise<void>;
  loadTriggerHealth: () => Promise<void>;
  loadTriggerRuns: (id: string) => Promise<void>;
  ensureTriggersLoaded: () => Promise<void>;
  createTrigger: (
    request: CreateTriggerRequest,
  ) => Promise<TriggerSummary | null>;
  updateTrigger: (
    id: string,
    request: UpdateTriggerRequest,
  ) => Promise<TriggerSummary | null>;
  deleteTrigger: (id: string) => Promise<boolean>;
  runTriggerNow: (id: string) => Promise<boolean>;
};
//# sourceMappingURL=useTriggersState.d.ts.map
