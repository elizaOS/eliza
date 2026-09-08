/** Keeps an authenticated first-run continuation bound to its original account and runtime selection through guarded publication. */

import {
  getStewardTabSessionAuthorityCoordinator,
  STEWARD_SESSION_CHANGE_EVENT,
  StewardSessionAuthorityError,
} from "@elizaos/shared/steward-session-client";
import type { ElizaClient } from "../api/client-base";
import { getBootConfig } from "../config/boot-config";
import {
  getActiveProfile,
  prepareAgentProfileRegistryDurably,
} from "../state/agent-profiles";
import { loadPersistedActiveServer } from "../state/persistence";

/** Capture after authentication, before the first account/agent request. */
export function createCloudContinuationAuthority(
  client: ElizaClient,
  parentSignal?: AbortSignal,
) {
  const coordinator = getStewardTabSessionAuthorityCoordinator();
  const session = coordinator.readSnapshot();
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  const cloudBase = getBootConfig().cloudApiBase;
  let clientBase = client.getBaseUrl();
  let clientRevision = client.getAuthorityRevision();
  let clientToken = client.getRestAuthToken();
  let server = JSON.stringify(loadPersistedActiveServer());
  // The profile reader can migrate a just-written legacy server. Reading the
  // raw registry here keeps validation itself free of selection mutations.
  let profile = window.localStorage.getItem("elizaos:agent-profiles");
  let writingClient = false;
  let clientNotifications = 0;

  const revalidate = () => {
    signal.throwIfAborted();
    coordinator.assertSnapshot(session);
    if (
      getBootConfig().cloudApiBase !== cloudBase ||
      client.getBaseUrl() !== clientBase ||
      client.getAuthorityRevision() !== clientRevision ||
      client.getRestAuthToken() !== clientToken ||
      JSON.stringify(loadPersistedActiveServer()) !== server ||
      window.localStorage.getItem("elizaos:agent-profiles") !== profile
    ) {
      throw new StewardSessionAuthorityError(
        "The first-run account or runtime selection changed",
        "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
      );
    }
  };
  const onChange = () => {
    if (writingClient) return;
    try {
      revalidate();
    } catch (error) {
      // error-policy:J4 superseded setup is cancelled; the conductor owns the
      // visible recovery turn when its interrupted operation settles.
      controller.abort(error);
    }
  };
  const unsubscribe = client.onAuthorityChange(() => {
    if (writingClient) clientNotifications += 1;
    else onChange();
  });
  window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, onChange);
  window.addEventListener("steward-token-sync", onChange);
  window.addEventListener("storage", onChange);

  return {
    signal,
    revalidate,
    async prepareProfiles() {
      profile = await prepareAgentProfileRegistryDurably(revalidate);
      revalidate();
    },
    /** Client setters emit synchronously; only this owned write may advance its captured revision. */
    commitClient(
      write: () => void,
      expected: { base: string | null } | { token: string | null },
    ) {
      revalidate();
      const nextBase =
        "base" in expected
          ? (expected.base ?? "").trim().replace(/\/+$/, "")
          : clientBase;
      const nextToken =
        "token" in expected ? expected.token?.trim() || null : clientToken;
      clientNotifications = 0;
      writingClient = true;
      try {
        write();
      } finally {
        writingClient = false;
      }
      const revision = client.getAuthorityRevision();
      // Each setter publishes at most one authority notification. A nested
      // listener transition (including ABA) must not become our new baseline.
      if (
        client.getBaseUrl() !== nextBase ||
        client.getRestAuthToken() !== nextToken ||
        clientNotifications > 1 ||
        revision < clientRevision ||
        revision > clientRevision + ("token" in expected ? 1 : 0)
      ) {
        throw new StewardSessionAuthorityError(
          "The first-run client publication was superseded",
          "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
        );
      }
      clientBase = nextBase;
      clientRevision = revision;
      clientToken = nextToken;
      revalidate();
    },
    /** Accept only the exact record that the guarded persistence just committed. */
    acceptServer(value: ReturnType<typeof loadPersistedActiveServer>) {
      server = JSON.stringify(value);
      revalidate();
    },
    acceptProfile(value: ReturnType<typeof getActiveProfile>) {
      if (JSON.stringify(getActiveProfile()) !== JSON.stringify(value))
        throw new Error("First-run profile did not round-trip");
      profile = window.localStorage.getItem("elizaos:agent-profiles");
      revalidate();
    },
    dispose() {
      unsubscribe();
      window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, onChange);
      window.removeEventListener("steward-token-sync", onChange);
      window.removeEventListener("storage", onChange);
    },
  };
}
