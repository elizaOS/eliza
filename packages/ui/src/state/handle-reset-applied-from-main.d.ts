/**
 * Renderer path after the **main process** finishes menu reset and pushes
 * `desktopTrayMenuClick` with `itemId: "menu-reset-app-applied"`.
 *
 * **WHY a separate module:** `AppProvider` is enormous; this flow needs lifecycle
 * guards, `setActionNotice`, and `finishLifecycleAction` in **unit tests** without
 * mounting React. **WHY reuse `completeResetLocalState`:** Settings `handleReset`
 * and main-process reset must apply the **same** client + onboarding + cloud
 * teardown or the two entry points drift.
 */
import type { AgentStatus } from "../api/client";
import { type LifecycleAction } from "./types";
export type HandleResetAppliedFromMainDeps = {
  performanceNow: () => number;
  isLifecycleBusy: () => boolean;
  getActiveLifecycleAction: () => LifecycleAction;
  beginLifecycleAction: (action: LifecycleAction) => boolean;
  finishLifecycleAction: () => void;
  setActionNotice: (
    text: string,
    tone: "info" | "success" | "error",
    ttlMs?: number,
    once?: boolean,
    busy?: boolean,
  ) => void;
  parseTrayResetPayload: (payload: unknown) => AgentStatus | null;
  completeResetLocalState: (
    postResetAgentStatus: AgentStatus | null,
  ) => Promise<void>;
  alertDesktopMessage: (args: {
    title: string;
    message: string;
    type: "error";
  }) => Promise<void>;
  logResetInfo: (message: string, detail?: Record<string, unknown>) => void;
  logResetWarn: (message: string, detail?: unknown) => void;
};
export declare function handleResetAppliedFromMainCore(
  payload: unknown,
  d: HandleResetAppliedFromMainDeps,
): Promise<void>;
//# sourceMappingURL=handle-reset-applied-from-main.d.ts.map
