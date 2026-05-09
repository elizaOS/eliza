/**
 * Wipes **renderer-local** state after the server already ran `POST /api/agent/reset`.
 *
 * **WHY:** post-wipe, persisted active server + API base + Eliza Cloud flags
 * could still point at cloud/remote, so onboarding never appeared "fresh."
 *
 * **WHY dependency injection:** `useChatLifecycle` is the sole production
 * caller and wires real `client` and React setters; the explicit deps record
 * keeps the orchestrator pure and lets unit tests assert call order without
 * jsdom (see `complete-reset-local-state-after-wipe.test.ts`).
 *
 * **Atomicity contract:**
 *  - All synchronous callbacks fire in fixed order before the `await`.
 *    React batches those setter calls into a single render commit, so the
 *    UI never observes a partial wipe state mid-cascade.
 *  - `fetchOnboardingOptions` is the only step allowed to fail. Its
 *    try/catch is in-function: a failed fetch leaves onboarding options
 *    stale but does NOT roll back the rest of the wipe (rolling back would
 *    be worse than stale options — the user could still re-fetch on next
 *    boot, but a half-wiped session leaks cloud/remote credentials).
 *  - All other callbacks are uncaught by design. If any throws, the entire
 *    cascade aborts and the failure surfaces to the calling lifecycle (the
 *    `handleResetAppliedFromMain` / `handleReset` callers in
 *    `useChatLifecycle.ts` show the desktop alert + log the warning). We do
 *    NOT swallow failures or default-fill state — that would mask a broken
 *    pipeline with apparent success.
 *  - The cascade is the sole caller of each deps-record callback. No code
 *    path calls one without the others, so the coupling-guarantee comments
 *    in `useChatLifecycle.ts` (token-clear ↔ markOnboardingReset) hold.
 */
import type { AgentStatus, OnboardingOptions } from "../api/client";

/**
 * Ports for `completeResetLocalStateAfterServerWipe` (all side effects explicit).
 */
export type CompleteResetLocalStateDeps = {
  setAgentStatus: (status: AgentStatus | null) => void;
  resetClientConnection: () => void;
  clearPersistedActiveServer: () => void;
  clearPersistedAvatarIndex: () => void;
  setClientBaseUrl: (url: string | null) => void;
  setClientToken: (token: string | null) => void;
  clearElizaCloudSessionUi: () => void;
  markOnboardingReset: () => void;
  resetAvatarSelection: () => void;
  clearConversationLists: () => void;
  fetchOnboardingOptions: () => Promise<OnboardingOptions>;
  setOnboardingOptions: (options: OnboardingOptions) => void;
  logResetDebug: (message: string, detail?: Record<string, unknown>) => void;
  logResetWarn: (message: string, detail?: unknown) => void;
};

export async function completeResetLocalStateAfterServerWipe(
  postResetAgentStatus: AgentStatus | null,
  d: CompleteResetLocalStateDeps,
): Promise<void> {
  d.setAgentStatus(postResetAgentStatus);
  d.logResetDebug("resetLocalState: client.resetConnection()");
  d.resetClientConnection();

  d.clearPersistedActiveServer();
  d.clearPersistedAvatarIndex();
  d.setClientBaseUrl(null);
  d.setClientToken(null);
  d.clearElizaCloudSessionUi();
  d.markOnboardingReset();
  d.resetAvatarSelection();
  d.clearConversationLists();
  try {
    d.logResetDebug("resetLocalState: fetching onboarding options after reset");
    const options = await d.fetchOnboardingOptions();
    d.setOnboardingOptions(options);
    d.logResetDebug("resetLocalState: onboarding options loaded", {
      styleCount: options.styles?.length ?? 0,
    });
  } catch (optErr) {
    d.logResetWarn(
      "resetLocalState: getOnboardingOptions failed after reset",
      optErr,
    );
  }
}
