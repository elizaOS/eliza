/**
 * Shared TypeScript types for onboarding **connection** subflow (`connection-flow.ts` + React screens).
 * **Why a separate file:** keeps `connection-flow.ts` focused on logic; types are easy to import without pulling in
 * transition implementations; avoids circular imports if other modules need only types.
 */

import type { AppState } from "../state/types";

export type ConnectionScreen =
  | "hosting"
  | "remoteBackend"
  | "elizaCloud_preProvider"
  | "providerGrid"
  | "providerDetail";

/**
 * Minimal fields for routing + `selectProvider` autofill. **Why not full `AppState`:** avoids dragging unrelated keys into
 * pure functions and keeps snapshots cheap to construct in tests.
 */
export type ConnectionFlowSnapshot = Pick<
  AppState,
  | "onboardingServerTarget"
  | "onboardingProvider"
  | "onboardingRemoteConnected"
  | "onboardingElizaCloudTab"
  | "onboardingSubscriptionTab"
> & {
  /** `branding.cloudOnly` — **why:** cloud-only distributions skip the hosting chooser entirely. */
  forceCloud: boolean;
  isNative: boolean;
  cloudOnly: boolean;
  /** Used only for `selectProvider` patch (detected API keys). */
  onboardingDetectedProviders: AppState["onboardingDetectedProviders"];
};

export type ConnectionStatePatch = Partial<{
  onboardingServerTarget: AppState["onboardingServerTarget"];
  onboardingCloudApiKey: string;
  onboardingProvider: string;
  onboardingApiKey: string;
  onboardingPrimaryModel: string;
  onboardingRemoteApiBase: string;
  onboardingRemoteToken: string;
  onboardingRemoteError: string | null;
  onboardingRemoteConnecting: boolean;
  onboardingRemoteConnected: boolean;
  onboardingSubscriptionTab: AppState["onboardingSubscriptionTab"];
  onboardingElizaCloudTab: AppState["onboardingElizaCloudTab"];
}>;

export type ConnectionEvent =
  | { type: "forceCloudBootstrap" }
  | { type: "selectLocalHosting" }
  | { type: "selectRemoteHosting" }
  | { type: "selectElizaCloudHosting" }
  | { type: "selectElizaCloudHybridHosting" }
  /** Remote form or provider grid footer: use local backend if already connected, else reset hosting */
  | { type: "backRemoteOrGrid" }
  /** Eliza Cloud (pre-provider) panel footer back */
  | { type: "backElizaCloudPreProvider" }
  | { type: "selectProvider"; providerId: string }
  | { type: "clearProvider" }
  | { type: "setElizaCloudTab"; tab: "login" | "apikey" }
  | { type: "setSubscriptionTab"; tab: "token" | "oauth" };

/** Shell maps this to `handleOnboardingUseLocalBackend`. **Why a token:** keeps pure module free of `client` / `retryStartup`. */
export type ConnectionEffect = "useLocalBackend";

/**
 * **Why two kinds:** most transitions only update onboarding fields; disconnecting remote requires imperative AppContext work.
 */
export type ConnectionTransitionResult =
  | { kind: "patch"; patch: ConnectionStatePatch }
  | { kind: "effect"; effect: ConnectionEffect };

/**
 * Layout/routing hints for React. **Why separate from `deriveConnectionScreen`:** same `screen` plus flags (e.g. hide local
 * hosting card) without recomputing policy in every view.
 */
export type ConnectionUiSpec = {
  screen: ConnectionScreen;
  showProviderSelection: boolean;
  showHostingLocalCard: boolean;
  forceCloud: boolean;
  /** Set when screen is providerDetail */
  providerId: string;
  elizaCloudTab: AppState["onboardingElizaCloudTab"];
  subscriptionTab: AppState["onboardingSubscriptionTab"];
};

/** Row shape for the `CONNECTION_TRANSITIONS` table in `connection-flow.ts` (documentation / human scan). */
export type ConnectionTransitionDocRow = {
  from: ConnectionScreen;
  event: ConnectionEvent["type"];
  to: ConnectionScreen | "effect:useLocalBackend" | "same";
  note?: string;
};
