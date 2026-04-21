/**
 * Wipes **renderer-local** state after the server already ran `POST /api/agent/reset`.
 *
 * **WHY:** post-wipe, persisted active server + API base + Eliza Cloud flags
 * could still point at cloud/remote, so onboarding never appeared “fresh.”
 * **WHY dependency injection:** `AppProvider` wires real `client` and setters;
 * tests inject mocks to assert order and error handling without jsdom.
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
