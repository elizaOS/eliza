/**
 * Pure connection onboarding subflow: screen derivation, UI spec, and state transitions.
 *
 * ## Why this file exists
 * The connection step had a very large React component where **branch order** and **setState blobs** were easy to break
 * and hard to test. This module holds **only** deterministic logic: given a snapshot, which screen; given an event, which
 * patch (or which *effect* the shell must run). **Why no React:** Vitest can run without jsdom; no accidental imports from
 * `components/`; reducers stay total and mock-free except for snapshots.
 *
 * ## Branch order (keep in sync with `ConnectionUiRoot` + screen components)
 * Mirrors the old outer `if` ladder: `if (!showProviderSelection)` then grid vs detail.
 *
 * 1. **showProviderSelection** = a hosting target is already chosen and either:
 *    - it is `local`
 *    - it is Eliza Cloud-hosted
 *    - or the user already connected to a remote backend
 *    **effectiveServerTarget:** if `forceCloud && onboardingServerTarget === ""`, use `"local"`. **Why:** cloud-only
 *    builds skip the hosting chooser and land directly on the provider grid.
 * 2. If `!showProviderSelection`:
 *    - `!effectiveServerTarget` → **hosting**
 *    - else → **remoteBackend**
 * 3. If `showProviderSelection && !onboardingProvider` → **providerGrid**
 * 4. Else → **providerDetail**
 *
 * Tests: `tests/connection-flow.test.ts`
 */

import type {
  ConnectionEvent,
  ConnectionFlowSnapshot,
  ConnectionScreen,
  ConnectionStatePatch,
  ConnectionTransitionDocRow,
  ConnectionTransitionResult,
  ConnectionUiSpec,
} from "./types";
import { type OnboardingServerTarget } from "./server-target";
import { canRunLocal } from "../platform/init";

export type {
  ConnectionEffect,
  ConnectionEvent,
  ConnectionFlowSnapshot,
  ConnectionScreen,
  ConnectionStatePatch,
  ConnectionTransitionDocRow,
  ConnectionTransitionResult,
  ConnectionUiSpec,
} from "./types";

/**
 * Recommended neural-link grid ids. **Why duplicated from UI:** the pure module must not import React components; keeping
 * the list here lets tests assert grid policy without rendering. **Drift risk:** if you change recommendations in the UI,
 * update this constant and `ConnectionStep` / grid screen (see README in `components/onboarding/connection/`).
 */
export const CONNECTION_RECOMMENDED_PROVIDER_IDS = [
  "elizacloud",
  "anthropic-subscription",
  "openai-subscription",
] as const;

/**
 * Documentation-only transition hints (onboarding guide, onboarding changelog). **Why not executable:** the real machine is
 * `applyConnectionTransition`; this table can drift—prefer tests when changing behavior.
 */
export const CONNECTION_TRANSITIONS: ReadonlyArray<ConnectionTransitionDocRow> =
  [
    {
      from: "hosting",
      event: "selectLocalHosting",
      to: "providerGrid",
    },
    {
      from: "hosting",
      event: "selectRemoteHosting",
      to: "remoteBackend",
    },
    {
      from: "hosting",
      event: "selectElizaCloudHosting",
      to: "providerGrid",
    },
    {
      from: "providerGrid",
      event: "selectProvider",
      to: "providerDetail",
    },
    {
      from: "providerDetail",
      event: "clearProvider",
      to: "providerGrid",
    },
    {
      from: "providerDetail",
      event: "setElizaCloudTab",
      to: "same",
    },
    {
      from: "providerDetail",
      event: "setSubscriptionTab",
      to: "same",
    },
    {
      from: "hosting",
      event: "forceCloudBootstrap",
      to: "providerGrid",
      note: "When forceCloud && server target empty (steady UI)",
    },
  ];

function toOnboardingTargetPatch(
  target: OnboardingServerTarget,
): ConnectionStatePatch {
  return {
    onboardingServerTarget: target,
  };
}

export function getEffectiveServerTarget(
  snapshot: ConnectionFlowSnapshot,
): OnboardingServerTarget {
  if (snapshot.forceCloud && snapshot.onboardingServerTarget === "") {
    return "local";
  }
  // Desktop or dev server → assume local, skip hosting choice screen entirely.
  if (canRunLocal() && snapshot.onboardingServerTarget === "") {
    return "local";
  }
  return snapshot.onboardingServerTarget;
}

/** True when the neural link grid path is active (local run mode or already connected to remote). */
export function computeShowProviderSelection(
  snapshot: ConnectionFlowSnapshot,
): boolean {
  if (snapshot.onboardingRemoteConnected) {
    return true;
  }

  const target = getEffectiveServerTarget(snapshot);
  if (!target) {
    return false;
  }

  return target !== "remote";
}

/**
 * **Precedence matters:** if multiple conditions could match, order must match `ConnectionUiRoot` / legacy `ConnectionStep`
 * outer returns. Add a `tests/connection-flow.test.ts` row for every new edge case.
 */
export function deriveConnectionScreen(
  snapshot: ConnectionFlowSnapshot,
): ConnectionScreen {
  const show = computeShowProviderSelection(snapshot);
  const target = getEffectiveServerTarget(snapshot);
  if (!show) {
    if (!target) return "hosting";
    return "remoteBackend";
  }
  if (!snapshot.onboardingProvider) return "providerGrid";
  return "providerDetail";
}

/** Single object for React: screen + flags + current tab ids. **Invariant:** `screen` always equals `deriveConnectionScreen(snapshot)` — enforced in tests. */
export function resolveConnectionUiSpec(
  snapshot: ConnectionFlowSnapshot,
): ConnectionUiSpec {
  const screen = deriveConnectionScreen(snapshot);
  const showProviderSelection = computeShowProviderSelection(snapshot);
  return {
    screen,
    showProviderSelection,
    showHostingLocalCard: !snapshot.cloudOnly && !snapshot.isNative,
    forceCloud: snapshot.forceCloud,
    providerId: snapshot.onboardingProvider,
    elizaCloudTab: snapshot.onboardingElizaCloudTab,
    subscriptionTab: snapshot.onboardingSubscriptionTab,
  };
}

const resetCloudSelectionPatch = (): ConnectionStatePatch => ({
  ...toOnboardingTargetPatch(""),
  onboardingCloudApiKey: "",
  onboardingApiKey: "",
  onboardingPrimaryModel: "",  // Also clear model when resetting cloud selection
  onboardingProvider: "",      // Clear provider when backing out of provider selection
  onboardingRemoteError: null,
  onboardingRemoteConnecting: false,
});

const resetHostingSelectionPatch = (): ConnectionStatePatch => ({
  ...resetCloudSelectionPatch(),
  onboardingSubscriptionTab: "token",
  onboardingElizaCloudTab: "login",
});

/**
 * Clears connection subflow state so the outer wizard **`hosting`** step shows the hosting *choice*
 * (`ConnectionHostingScreen`) instead of a stale remote/provider screen from a prior selection.
 *
 * **When:** `revertOnboarding` / sidebar jump from `providers` (or later) back to `hosting` — previously
 * only `onboardingStep` changed, so `deriveConnectionScreen` still returned the Eliza Cloud pre-provider UI.
 */
export function getResetConnectionWizardToHostingStepPatch(): ConnectionStatePatch {
  return {
    ...resetHostingSelectionPatch(),
    onboardingProvider: "",
    onboardingPrimaryModel: "",
    onboardingRemoteApiBase: "",
    onboardingRemoteToken: "",
    onboardingRemoteConnected: false,
  };
}

/**
 * Pure transition step. **Returns `null`** when the event is a no-op for this snapshot (e.g. bootstrap when not forced).
 * **Never** call `client` or async login here—return `effect` and let `ConnectionStep` invoke AppContext.
 */
export function applyConnectionTransition(
  snapshot: ConnectionFlowSnapshot,
  event: ConnectionEvent,
): ConnectionTransitionResult | null {
  switch (event.type) {
    case "forceCloudBootstrap": {
      if (!snapshot.forceCloud || snapshot.onboardingServerTarget !== "") {
        return null;
      }
      return {
        kind: "patch",
        patch: {
          ...toOnboardingTargetPatch("local"),
          onboardingProvider: "",
          onboardingApiKey: "",
          onboardingPrimaryModel: "",
        },
      };
    }
    case "selectLocalHosting":
      return {
        kind: "patch",
        patch: {
          ...toOnboardingTargetPatch("local"),
          onboardingRemoteError: null,
          onboardingRemoteConnecting: false,
        },
      };
    case "selectRemoteHosting":
      return {
        kind: "patch",
        patch: {
          ...toOnboardingTargetPatch("remote"),
          onboardingProvider: "",
          onboardingApiKey: "",
          onboardingPrimaryModel: "",
        },
      };
    case "selectElizaCloudHosting":
      return {
        kind: "patch",
        patch: {
          ...toOnboardingTargetPatch("elizacloud"),
          onboardingProvider: "",
          onboardingApiKey: "",
          onboardingPrimaryModel: "",
        },
      };
    case "backRemoteOrGrid": {
      // Why effect when connected: matches legacy handleRemoteBack / grid back — must clear client base URL + retryStartup.
      if (snapshot.onboardingRemoteConnected) {
        return { kind: "effect", effect: "useLocalBackend" };
      }
      return { kind: "patch", patch: resetHostingSelectionPatch() };
    }
    case "backElizaCloudPreProvider":
      return { kind: "patch", patch: resetHostingSelectionPatch() };
    case "selectProvider": {
      const detected = snapshot.onboardingDetectedProviders?.find(
        (d) => d.id === event.providerId,
      );
      const patch: ConnectionStatePatch =
        event.providerId === "elizacloud"
          ? {
              onboardingProvider: event.providerId,
              onboardingApiKey: "",
              onboardingPrimaryModel: "",
              ...(detected?.apiKey
                ? { onboardingCloudApiKey: detected.apiKey }
                : {}),
            }
          : {
              onboardingProvider: event.providerId,
              onboardingApiKey: detected?.apiKey ?? "",
              onboardingPrimaryModel: "",
            };
      if (event.providerId === "anthropic-subscription") {
        patch.onboardingSubscriptionTab = "token";
      }
      return { kind: "patch", patch };
    }
    case "clearProvider":
      return {
        kind: "patch",
        patch: {
          onboardingProvider: "",
          onboardingApiKey: "",
          onboardingPrimaryModel: "",
        },
      };
    case "setElizaCloudTab":
      return {
        kind: "patch",
        patch: { onboardingElizaCloudTab: event.tab },
      };
    case "setSubscriptionTab":
      return {
        kind: "patch",
        patch: { onboardingSubscriptionTab: event.tab },
      };
    default: {
      const _exhaustive: never = event;
      console.warn(
        "[connection-flow] Unhandled connection event:",
        (_exhaustive as ConnectionEvent).type,
      );
      return null;
    }
  }
}

/** Providers that do not require an API key to proceed. */
const NO_KEY_REQUIRED = new Set(["ollama"]);

/**
 * Pure predicate: should the CONFIRM button be disabled on the provider-detail screen?
 * Extracted so tests can cover every provider path without rendering React.
 */
export function isProviderConfirmDisabled(opts: {
  provider: string;
  apiKey: string;
  elizaCloudTab: "login" | "apikey";
  elizaCloudConnected: boolean;
  subscriptionTab: "token" | "oauth";
}): boolean {
  const {
    provider,
    apiKey,
    elizaCloudTab,
    elizaCloudConnected,
    subscriptionTab,
  } = opts;
  if (!provider) return true;
  if (provider === "elizacloud") {
    return (
      (elizaCloudTab === "login" && !elizaCloudConnected) ||
      (elizaCloudTab === "apikey" && !apiKey.trim())
    );
  }
  if (provider === "anthropic-subscription") {
    return subscriptionTab === "token" && !apiKey.trim();
  }
  if (NO_KEY_REQUIRED.has(provider)) return false;
  // All other providers require an API key
  return !apiKey.trim();
}

/**
 * For tests: merge patch into snapshot fields that affect **routing** only. **Why ignore apiKey/primaryModel:** they are not
 * on `ConnectionFlowSnapshot`; `deriveConnectionScreen` does not read them.
 */
export function mergeConnectionSnapshot(
  base: ConnectionFlowSnapshot,
  patch: ConnectionStatePatch,
): ConnectionFlowSnapshot {
  const next: ConnectionFlowSnapshot = { ...base };
  if (patch.onboardingServerTarget !== undefined) {
    next.onboardingServerTarget = patch.onboardingServerTarget;
  }
  if (patch.onboardingProvider !== undefined) {
    next.onboardingProvider = patch.onboardingProvider;
  }
  if (patch.onboardingRemoteConnected !== undefined) {
    next.onboardingRemoteConnected = patch.onboardingRemoteConnected;
  }
  if (patch.onboardingElizaCloudTab !== undefined) {
    next.onboardingElizaCloudTab = patch.onboardingElizaCloudTab;
  }
  if (patch.onboardingSubscriptionTab !== undefined) {
    next.onboardingSubscriptionTab = patch.onboardingSubscriptionTab;
  }
  return next;
}
