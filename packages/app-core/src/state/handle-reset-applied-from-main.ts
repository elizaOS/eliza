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
import { LIFECYCLE_MESSAGES, type LifecycleAction } from "./types";

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

export async function handleResetAppliedFromMainCore(
  payload: unknown,
  d: HandleResetAppliedFromMainDeps,
): Promise<void> {
  d.logResetInfo(
    "handleResetAppliedFromMain: main process finished reset — syncing renderer state",
  );
  if (d.isLifecycleBusy()) {
    const activeAction = d.getActiveLifecycleAction();
    d.logResetInfo("handleResetAppliedFromMain: skipped — lifecycle busy", {
      activeAction,
    });
    d.setActionNotice(
      `Agent action already in progress (${LIFECYCLE_MESSAGES[activeAction].inProgress}). Please wait.`,
      "info",
      2800,
    );
    return;
  }
  if (!d.beginLifecycleAction("reset")) {
    d.setActionNotice(
      "Another agent operation is still running. Wait for it to finish, then try Reset again.",
      "info",
      4200,
    );
    return;
  }
  d.setActionNotice(
    LIFECYCLE_MESSAGES.reset.progress,
    "info",
    120_000,
    false,
    true,
  );
  const resetStartedAt = d.performanceNow();
  try {
    const parsedStatus = d.parseTrayResetPayload(payload);
    await d.completeResetLocalState(parsedStatus);
    const elapsedMs = Math.round(d.performanceNow() - resetStartedAt);
    d.logResetInfo(
      "handleResetAppliedFromMain: success — local UI synced after shell reset",
      { elapsedMs },
    );
    d.setActionNotice(LIFECYCLE_MESSAGES.reset.success, "success", 3200);
  } catch (err) {
    const elapsedMs = Math.round(d.performanceNow() - resetStartedAt);
    d.logResetWarn(
      "handleResetAppliedFromMain: failed while syncing local UI",
      { err, elapsedMs },
    );
    d.setActionNotice(
      `Failed to ${LIFECYCLE_MESSAGES.reset.verb} agent: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
      "error",
      4200,
    );
    await d.alertDesktopMessage({
      title: "Reset Failed",
      message: "Reset ran in the desktop shell but the UI could not refresh.",
      type: "error",
    });
  } finally {
    d.finishLifecycleAction();
  }
}
