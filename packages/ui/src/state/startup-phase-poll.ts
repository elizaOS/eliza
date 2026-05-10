/**
 * startup-phase-poll.ts
 *
 * Side-effect logic for the "polling-backend" startup phase.
 * Polls the backend until it responds, then dispatches BACKEND_REACHED
 * or an appropriate error/auth event.
 */

import { logger } from "@elizaos/core";
import { getStylePresets } from "@elizaos/shared";
import type { OnboardingOptions } from "../api";
import { client } from "../api";
import { getBackendStartupTimeoutMs, scanProviderCredentials } from "../bridge";
import type { UiLanguage } from "../i18n";
import type { OnboardingServerTarget } from "../onboarding/server-target";
import {
  asApiLikeError,
  clearPersistedOnboardingStep,
  deriveOnboardingResumeFieldsFromConfig,
  formatStartupErrorDetail,
  inferOnboardingResumeStep,
  type StartupErrorState,
} from "./internal";
import {
  loadPersistedOnboardingStep,
  savePersistedActiveServer,
} from "./persistence";
import type { PlatformPolicy, StartupEvent } from "./startup-coordinator";
import type { RestoringSessionCtx } from "./startup-phase-restore";
import type { OnboardingStep } from "./types";

export interface PollingBackendDeps {
  setStartupError: (v: StartupErrorState | null) => void;
  setAuthRequired: (v: boolean) => void;
  setOnboardingComplete: (v: boolean) => void;
  setOnboardingLoading: (v: boolean) => void;
  setOnboardingOptions: (v: OnboardingOptions) => void;
  setOnboardingStep: (v: OnboardingStep) => void;
  setOnboardingServerTarget: (v: OnboardingServerTarget) => void;
  setOnboardingCloudApiKey: (v: string) => void;
  setOnboardingProvider: (v: string) => void;
  setOnboardingVoiceProvider: (v: string) => void;
  setOnboardingApiKey: (v: string) => void;
  setOnboardingPrimaryModel: (v: string) => void;
  setOnboardingOpenRouterModel: (v: string) => void;
  setOnboardingRemoteConnected: (v: boolean) => void;
  setOnboardingRemoteApiBase: (v: string) => void;
  setOnboardingRemoteToken: (v: string) => void;
  setOnboardingSmallModel: (v: string) => void;
  setOnboardingLargeModel: (v: string) => void;
  setOnboardingCloudProvisionedContainer: (v: boolean) => void;
  setPairingEnabled: (v: boolean) => void;
  setPairingExpiresAt: (v: number | null) => void;
  applyDetectedProviders: (
    detected: Awaited<ReturnType<typeof scanProviderCredentials>>,
  ) => void;
  onboardingCompletionCommittedRef: React.MutableRefObject<boolean>;
  uiLanguage: UiLanguage;
}

/** Apply resume fields derived from a partial config to the onboarding state. */
function applyOnboardingResumeFields(
  rf: ReturnType<typeof deriveOnboardingResumeFieldsFromConfig>,
  deps: Pick<
    PollingBackendDeps,
    | "setOnboardingServerTarget"
    | "setOnboardingCloudApiKey"
    | "setOnboardingProvider"
    | "setOnboardingVoiceProvider"
    | "setOnboardingApiKey"
    | "setOnboardingPrimaryModel"
    | "setOnboardingOpenRouterModel"
    | "setOnboardingRemoteConnected"
    | "setOnboardingRemoteApiBase"
    | "setOnboardingRemoteToken"
    | "setOnboardingSmallModel"
    | "setOnboardingLargeModel"
  >,
): void {
  if (rf.onboardingServerTarget !== undefined)
    deps.setOnboardingServerTarget(rf.onboardingServerTarget);
  if (rf.onboardingCloudApiKey !== undefined)
    deps.setOnboardingCloudApiKey(rf.onboardingCloudApiKey);
  if (rf.onboardingProvider !== undefined)
    deps.setOnboardingProvider(rf.onboardingProvider);
  if (rf.onboardingVoiceProvider !== undefined)
    deps.setOnboardingVoiceProvider(rf.onboardingVoiceProvider);
  if (rf.onboardingApiKey !== undefined)
    deps.setOnboardingApiKey(rf.onboardingApiKey);
  if (rf.onboardingPrimaryModel !== undefined)
    deps.setOnboardingPrimaryModel(rf.onboardingPrimaryModel);
  if (rf.onboardingOpenRouterModel !== undefined)
    deps.setOnboardingOpenRouterModel(rf.onboardingOpenRouterModel);
  if (rf.onboardingRemoteConnected !== undefined)
    deps.setOnboardingRemoteConnected(rf.onboardingRemoteConnected);
  if (rf.onboardingRemoteApiBase !== undefined)
    deps.setOnboardingRemoteApiBase(rf.onboardingRemoteApiBase);
  if (rf.onboardingRemoteToken !== undefined)
    deps.setOnboardingRemoteToken(rf.onboardingRemoteToken);
  if (rf.onboardingSmallModel !== undefined)
    deps.setOnboardingSmallModel(rf.onboardingSmallModel);
  if (rf.onboardingLargeModel !== undefined)
    deps.setOnboardingLargeModel(rf.onboardingLargeModel);
}

/**
 * Runs the polling-backend phase.
 * Polls /auth/status and /onboarding/status until the backend is reachable
 * and onboarding state is determined.
 *
 * @param deps - Coordinator dependency bag
 * @param dispatch - startupReducer dispatch
 * @param policy - Platform policy (timeout etc.)
 * @param ctx - Session context populated by the restoring-session phase
 * @param effectRunId - The run ID of the calling effect (for stale-close guard)
 * @param effectRunRef - Shared ref tracking the latest run ID
 * @param cancelled - Ref-flag set true by the cleanup function
 * @param tidRef - Mutable ref for the pending setTimeout handle (for cleanup)
 */
export async function runPollingBackend(
  deps: PollingBackendDeps,
  dispatch: (event: StartupEvent) => void,
  policy: PlatformPolicy,
  ctx: RestoringSessionCtx | null,
  effectRunId: number,
  effectRunRef: React.MutableRefObject<number>,
  cancelled: { current: boolean },
  tidRef: { current: ReturnType<typeof setTimeout> | null },
): Promise<void> {
  const describeBackendFailure = (
    err: unknown,
    timedOut: boolean,
  ): StartupErrorState => {
    const apiErr = asApiLikeError(err);
    if (apiErr?.kind === "http" && apiErr.status === 404)
      return {
        reason: "backend-unreachable",
        phase: "starting-backend",
        message:
          "Backend API routes are unavailable on this origin (received 404).",
        detail: formatStartupErrorDetail(err),
        status: apiErr.status,
        path: apiErr.path,
      };
    if (timedOut || apiErr?.kind === "timeout")
      return {
        reason: "backend-timeout",
        phase: "starting-backend",
        message: `Backend did not become reachable within ${Math.round(getBackendStartupTimeoutMs() / 1000)}s.`,
        detail: formatStartupErrorDetail(err),
        status: apiErr?.status,
        path: apiErr?.path,
      };
    return {
      reason: "backend-unreachable",
      phase: "starting-backend",
      message: "Failed to reach backend during startup.",
      detail: formatStartupErrorDetail(err),
      status: apiErr?.status,
      path: apiErr?.path,
    };
  };

  const deadline = Date.now() + policy.backendTimeoutMs;
  let attempts = 0;
  let lastErr: unknown = null;
  let latestAuth: Awaited<ReturnType<typeof client.getAuthStatus>> = {
    required: false,
    pairingEnabled: false,
    expiresAt: null as number | null,
  };

  while (!cancelled.current && effectRunRef.current === effectRunId) {
    if (Date.now() >= deadline) {
      deps.setStartupError(describeBackendFailure(lastErr, true));
      deps.setOnboardingLoading(false);
      dispatch({ type: "BACKEND_TIMEOUT" });
      return;
    }
    try {
      const auth = await client.getAuthStatus();
      latestAuth = auth;
      if (cancelled.current) return;
      if (auth.required && !auth.authenticated && !client.hasToken()) {
        if (auth.bootstrapRequired) {
          deps.setAuthRequired(false);
          deps.setOnboardingCloudProvisionedContainer(true);
          deps.setOnboardingComplete(false);
          deps.setOnboardingLoading(false);
          dispatch({ type: "BACKEND_REACHED", onboardingComplete: false });
          return;
        }
        deps.setAuthRequired(true);
        deps.setPairingEnabled(auth.pairingEnabled);
        deps.setPairingExpiresAt(auth.expiresAt);
        deps.setOnboardingLoading(false);
        dispatch({ type: "BACKEND_AUTH_REQUIRED" });
        return;
      }
      // Token holder, but the server still says auth is required (e.g. the
      // remote owner password has not been set yet, so /api/auth/me will
      // return 401 with reason="remote_password_not_configured"). Don't
      // loop polling forever — advance the coordinator to "ready" so the
      // top-level auth gate can render LoginView with an actionable
      // "Remote access blocked" message. Without this, the phone is stuck
      // on the splash because every onboarding/runtime endpoint returns 401.
      if (auth.required && !auth.authenticated && client.hasToken()) {
        deps.setAuthRequired(false);
        deps.setOnboardingComplete(true);
        deps.setOnboardingLoading(false);
        dispatch({ type: "BACKEND_REACHED", onboardingComplete: true });
        return;
      }
      const onboardingStatusRes = await client.getOnboardingStatus();
      const { complete, cloudProvisioned } = onboardingStatusRes;
      if (cancelled.current) return;
      deps.setOnboardingCloudProvisionedContainer(Boolean(cloudProvisioned));
      let sessionComplete =
        complete ||
        deps.onboardingCompletionCommittedRef.current ||
        (ctx?.shouldPreserveCompletedOnboarding ?? false);

      // Preserve backend-complete installs even when this browser has no prior
      // local state (for example headless/VPS setups or a fresh visit to a
      // cloud-provisioned container). Only clear the optimistic completion
      // flag when the backend itself still reports onboarding as incomplete.
      if (
        sessionComplete &&
        !complete &&
        !ctx?.persistedActiveServer &&
        !ctx?.hadPriorOnboarding
      ) {
        sessionComplete = false;
      }

      if (complete && sessionComplete) {
        clearPersistedOnboardingStep();
      }
      if (
        sessionComplete &&
        !ctx?.persistedActiveServer &&
        ctx?.restoredActiveServer
      ) {
        savePersistedActiveServer(ctx.restoredActiveServer);
      }
      if (!complete && ctx?.shouldPreserveCompletedOnboarding)
        logger.warn(
          "[eliza][startup:init] Preserving completed onboarding despite incomplete backend onboarding status.",
        );
      deps.setOnboardingComplete(sessionComplete);

      if (!sessionComplete) {
        // Fetch onboarding options
        const optDeadline = Date.now() + getBackendStartupTimeoutMs();
        let optErr: unknown = null;
        while (!cancelled.current && effectRunRef.current === effectRunId) {
          if (Date.now() >= optDeadline) {
            deps.setStartupError(describeBackendFailure(optErr, true));
            deps.setOnboardingLoading(false);
            dispatch({ type: "BACKEND_TIMEOUT" });
            return;
          }
          try {
            const [options, config] = await Promise.all([
              client.getOnboardingOptions(),
              client.getConfig().catch(() => null),
            ]);
            if (deps.onboardingCompletionCommittedRef.current) {
              deps.setOnboardingLoading(false);
              dispatch({ type: "ONBOARDING_COMPLETE" });
              return;
            }
            const rf = deriveOnboardingResumeFieldsFromConfig(config);
            deps.setOnboardingOptions({
              ...options,
              styles:
                options.styles.length > 0
                  ? options.styles
                  : getStylePresets(deps.uiLanguage),
            });
            if (!rf.onboardingProvider) {
              try {
                const det = await scanProviderCredentials();
                if (det.length > 0) deps.applyDetectedProviders(det);
              } catch {}
            }
            applyOnboardingResumeFields(rf, deps);
            deps.setOnboardingStep(
              inferOnboardingResumeStep({
                persistedStep: loadPersistedOnboardingStep(),
                config,
              }),
            );
            deps.setOnboardingLoading(false);
            dispatch({
              type: "BACKEND_REACHED",
              onboardingComplete: false,
            });
            return;
          } catch (err) {
            const ae = asApiLikeError(err);
            if (ae?.status === 401 && client.hasToken()) {
              // Transient 401: retry. /api/auth/status is the auth gate.
              optErr = err;
              await new Promise<void>((r) => {
                tidRef.current = setTimeout(r, 500);
              });
              continue;
            }
            if (ae?.status === 404) {
              deps.setStartupError(describeBackendFailure(err, false));
              deps.setOnboardingLoading(false);
              dispatch({ type: "BACKEND_NOT_FOUND" });
              return;
            }
            optErr = err;
            await new Promise<void>((r) => {
              tidRef.current = setTimeout(r, 500);
            });
          }
        }
        return;
      }
      dispatch({ type: "BACKEND_REACHED", onboardingComplete: true });
      return;
    } catch (err) {
      const ae = asApiLikeError(err);
      if (ae?.status === 401 && !client.hasToken()) {
        deps.setAuthRequired(true);
        deps.setPairingEnabled(latestAuth.pairingEnabled);
        deps.setPairingExpiresAt(latestAuth.expiresAt);
        deps.setOnboardingLoading(false);
        dispatch({ type: "BACKEND_AUTH_REQUIRED" });
        return;
      }
      if (
        (ae?.status === 401 || ae?.status === 429) &&
        client.hasToken() &&
        latestAuth.authenticated
      ) {
        // Bearer-only token (paired but no password session). /api/auth/status
        // returned authenticated:true but a downstream endpoint
        // (onboarding-status, etc.) still 401s, or the server's auth rate
        // limiter starts returning 429 ("Too many authentication attempts")
        // because every poll re-checks bearer-vs-session. /api/auth/me responds
        // with reason="remote_auth_required" in this state. Don't loop forever
        // — advance to ready so the top-level auth gate can render LoginView
        // with an actionable "Sign in" / "Remote access blocked" prompt.
        deps.setAuthRequired(false);
        deps.setOnboardingComplete(true);
        deps.setOnboardingLoading(false);
        dispatch({ type: "BACKEND_REACHED", onboardingComplete: true });
        return;
      }
      if (
        ae?.status === 401 &&
        client.hasToken() &&
        latestAuth.required &&
        latestAuth.authenticated === false
      ) {
        // Stale bearer: token is in storage and we've already seen
        // /api/auth/status report `required:true, authenticated:false`.
        // Server is definitively rejecting this session — retrying every
        // 250-1000ms for 15s won't change that, it just dead-ends on
        // BACKEND_TIMEOUT with the last 401 detail. Route straight to the
        // pairing/login gate so the user can re-pair or sign in.
        deps.setAuthRequired(true);
        deps.setPairingEnabled(latestAuth.pairingEnabled);
        deps.setPairingExpiresAt(latestAuth.expiresAt);
        deps.setOnboardingLoading(false);
        dispatch({ type: "BACKEND_AUTH_REQUIRED" });
        return;
      }
      if (ae?.status === 401 && client.hasToken()) {
        // 401-with-token but auth/status hasn't confirmed authenticated:true
        // OR authenticated:false yet — port race / pre-bearer endpoint
        // window before the first auth/status poll completes. Fall through
        // to retry.
      }
      if (ae?.status === 404) {
        deps.setStartupError(describeBackendFailure(err, false));
        deps.setOnboardingLoading(false);
        dispatch({ type: "BACKEND_NOT_FOUND" });
        return;
      }
      lastErr = err;
      attempts++;
      const delay = Math.min(250 * 2 ** Math.min(attempts, 2), 1000);
      await new Promise<void>((r) => {
        tidRef.current = setTimeout(r, delay);
      });
    }
  }
}
