/**
 * First-run callbacks — extracted from AppContext.
 *
 * Holds the callback functions for the first-run setup:
 * completeFirstRun, goToFirstRunStep, applyResetConnectionWizardToHostingStep,
 * revertFirstRun / handleFirstRunBack, handleFirstRunJumpToStep,
 * handleFirstRunUseLocalBackend, handleFirstRunRemoteConnect, and
 * applyDetectedProviders.
 *
 * The legacy full-screen step-machine finish chain (runFirstRunChatHandoff /
 * handleFirstRunFinish / advanceFirstRun / handleFirstRunNext /
 * handleCloudFirstRunFinish) was removed in #9952: onboarding now runs in the
 * chat, and the single provisioning path lives in
 * `first-run/first-run-finish.ts` driven by `use-first-run-conductor.ts`.
 */

import { type RefObject, useCallback } from "react";
import { ElizaClient } from "../api/client-base";

type FirstRunClient = Pick<
  ElizaClient,
  | "getAuthStatus"
  | "getBaseUrl"
  | "getStatus"
  | "selectOrProvisionCloudAgent"
  | "setBaseUrl"
  | "setToken"
  | "startAgent"
  | "submitFirstRun"
  | "updateConfig"
>;

import type { scanProviderCredentials } from "../bridge";
import { persistMobileRuntimeModeForServerTarget } from "../first-run/mobile-runtime-mode";
import {
  canRevertSetupTo,
  getFlaminaTopicForSetupStep,
  getSetupStepIndex,
  resolveSetupPreviousStep,
} from "../first-run/setup-steps";
import type { UiLanguage } from "../i18n";
import type { Tab } from "../navigation";
import {
  clearPersistedActiveServer,
  clearPersistedSetupStep,
  createPersistedActiveServer,
  savePersistedActiveServer,
} from "./internal";
import type { AppState, SetupStep } from "./types";
import type { FirstRunStateHook } from "./useFirstRunState";

// ── Helpers copied from AppContext (module-level, no React deps) ──────────

function isPrivateNetworkHost(host: string): boolean {
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return true;
  }
  return false;
}

function normalizeRemoteApiBaseInput(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new Error("Enter a backend address.");
  }
  const hasScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed);
  const hostGuess = trimmed.replace(/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//, "");
  const guessedHost = hostGuess.split("/")[0]?.replace(/:\d+$/, "") ?? "";
  const defaultProtocol = isPrivateNetworkHost(guessedHost) ? "http" : "https";
  const candidate = hasScheme ? trimmed : `${defaultProtocol}://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Enter a valid backend address.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Remote backends must use http:// or https://.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

// ── Hook deps ─────────────────────────────────────────────────────────────

export interface FirstRunCallbacksDeps {
  /** Full result of useFirstRunState — state + all dispatch helpers. */
  firstRun: FirstRunStateHook;

  /**
   * Compat setter functions that already wrap firstRun.setField / dispatch.
   * Passed in from AppContext so we don't duplicate them here.
   */
  setSetupStep: (step: SetupStep) => void;
  setFirstRunMode: (v: AppState["firstRunMode"]) => void;
  setFirstRunActiveGuide: (v: string | null) => void;
  addDeferredFirstRunTask: (task: string) => void;
  setFirstRunDetectedProviders: (
    v: AppState["firstRunDetectedProviders"],
  ) => void;
  setFirstRunRuntimeTarget: (v: AppState["firstRunRuntimeTarget"]) => void;
  setFirstRunCloudApiKey: (v: string) => void;
  setFirstRunProvider: (v: string) => void;
  setFirstRunApiKey: (v: string) => void;
  setFirstRunPrimaryModel: (v: string) => void;
  setFirstRunRemoteApiBase: (v: string) => void;
  setFirstRunRemoteToken: (v: string) => void;
  setFirstRunRemoteConnecting: (v: boolean) => void;
  setFirstRunRemoteError: (v: string | null) => void;
  setFirstRunRemoteConnected: (v: boolean) => void;
  setPostFirstRunChecklistDismissed: (v: boolean) => void;
  setBrowserEnabled?: (v: boolean) => void;
  setComputerUseEnabled?: (v: boolean) => void;
  setWalletEnabled?: (v: boolean) => void;

  /** Lifecycle / global */
  setFirstRunComplete: (v: boolean) => void;
  coordinatorFirstRunCompleteRef: RefObject<(() => void) | null>;
  initialTabSetRef: RefObject<boolean>;
  setTab: (tab: Tab) => void;
  defaultLandingTab: Tab;
  loadCharacter: () => Promise<void>;
  uiLanguage: UiLanguage;
  selectedVrmIndex: number;
  walletConfig: AppState["walletConfig"];
  elizaCloudConnected: boolean;
  setActionNotice: (
    text: string,
    tone?: "info" | "success" | "error",
    ttlMs?: number,
  ) => void;
  retryStartup: () => void;
  forceLocalBootstrapRef: RefObject<boolean>;
  client: FirstRunClient;
}

// ── Hook ──────────────────────────────────────────────────────────────────

export function useFirstRunCallbacks(deps: FirstRunCallbacksDeps) {
  const {
    firstRun,
    setSetupStep,
    setFirstRunMode: _setFirstRunMode,
    setFirstRunActiveGuide,
    setFirstRunDetectedProviders,
    setFirstRunRuntimeTarget,
    setFirstRunCloudApiKey,
    setFirstRunProvider,
    setFirstRunApiKey,
    setFirstRunPrimaryModel: _setFirstRunPrimaryModel,
    setFirstRunRemoteApiBase,
    setFirstRunRemoteToken,
    setFirstRunRemoteConnecting,
    setFirstRunRemoteError,
    setFirstRunRemoteConnected,
    setPostFirstRunChecklistDismissed,
    setFirstRunComplete,
    coordinatorFirstRunCompleteRef,
    initialTabSetRef,
    setTab,
    defaultLandingTab,
    loadCharacter,
    setActionNotice,
    retryStartup,
    forceLocalBootstrapRef,
    client,
  } = deps;

  // Destructure state fields we need from the firstRun hook
  const {
    state: {
      step: setupStep,
      mode: firstRunMode,
      detectedProviders: firstRunDetectedProviders,
      remoteApiBase: firstRunRemoteApiBase,
      remoteToken: firstRunRemoteToken,
      remote: firstRunRemote,
    },
    completionCommittedRef: firstRunCompletionCommittedRef,
  } = firstRun;

  const firstRunRemoteConnecting = firstRunRemote.status === "connecting";

  // ── completeFirstRun ────────────────────────────────────────────

  const completeFirstRun = useCallback(
    (landingTab: Tab = defaultLandingTab) => {
      clearPersistedSetupStep();
      firstRunCompletionCommittedRef.current = true;
      _setFirstRunMode("basic");
      setFirstRunActiveGuide(null);
      setPostFirstRunChecklistDismissed(false);
      setFirstRunDetectedProviders(
        firstRunDetectedProviders.map((provider) => {
          const { apiKey: _, ...rest } = provider;
          return rest;
        }) as AppState["firstRunDetectedProviders"],
      );
      setFirstRunComplete(true);
      coordinatorFirstRunCompleteRef.current?.();
      initialTabSetRef.current = true;
      setTab(landingTab);
      void loadCharacter();
    },
    [
      firstRunCompletionCommittedRef,
      firstRunDetectedProviders,
      setFirstRunActiveGuide,
      setFirstRunComplete,
      setFirstRunDetectedProviders,
      _setFirstRunMode,
      setPostFirstRunChecklistDismissed,
      setTab,
      defaultLandingTab,
      loadCharacter,
      coordinatorFirstRunCompleteRef,
      initialTabSetRef,
    ],
  );

  // ── goToFirstRunStep ───────────────────────────────────────────

  const goToFirstRunStep = useCallback(
    (step: SetupStep) => {
      setSetupStep(step);
      setFirstRunActiveGuide(
        firstRunMode === "advanced" ? getFlaminaTopicForSetupStep(step) : null,
      );
    },
    [firstRunMode, setSetupStep, setFirstRunActiveGuide],
  );

  // ── applyResetConnectionWizardToHostingStep ───────────────────────
  // Clears residual runtime and provider selection state before a user
  // picks a different setup target.
  const applyResetConnectionWizardToHostingStep = useCallback(() => {
    const patch = {
      firstRunRuntimeTarget: "" as const,
      firstRunCloudApiKey: "",
      firstRunApiKey: "",
      firstRunPrimaryModel: "",
      firstRunProvider: "",
      firstRunRemoteApiBase: "",
      firstRunRemoteToken: "",
      firstRunRemoteConnected: false,
      firstRunRemoteError: null,
      firstRunRemoteConnecting: false,
    };
    if (patch.firstRunRuntimeTarget !== undefined) {
      persistMobileRuntimeModeForServerTarget(patch.firstRunRuntimeTarget);
      setFirstRunRuntimeTarget(patch.firstRunRuntimeTarget);
    }
    if (patch.firstRunCloudApiKey !== undefined) {
      setFirstRunCloudApiKey(patch.firstRunCloudApiKey);
    }
    if (patch.firstRunProvider !== undefined) {
      setFirstRunProvider(patch.firstRunProvider);
    }
    if (patch.firstRunApiKey !== undefined) {
      setFirstRunApiKey(patch.firstRunApiKey);
    }
    if (patch.firstRunPrimaryModel !== undefined) {
      _setFirstRunPrimaryModel(patch.firstRunPrimaryModel);
    }
    if (patch.firstRunRemoteApiBase !== undefined) {
      setFirstRunRemoteApiBase(patch.firstRunRemoteApiBase);
    }
    if (patch.firstRunRemoteToken !== undefined) {
      setFirstRunRemoteToken(patch.firstRunRemoteToken);
    }
    if (patch.firstRunRemoteError !== undefined) {
      setFirstRunRemoteError(patch.firstRunRemoteError);
    }
    if (patch.firstRunRemoteConnecting !== undefined) {
      setFirstRunRemoteConnecting(patch.firstRunRemoteConnecting);
    }
    if (patch.firstRunRemoteConnected !== undefined) {
      setFirstRunRemoteConnected(patch.firstRunRemoteConnected);
    }
  }, [
    setFirstRunApiKey,
    setFirstRunCloudApiKey,
    setFirstRunRuntimeTarget,
    _setFirstRunPrimaryModel,
    setFirstRunProvider,
    setFirstRunRemoteApiBase,
    setFirstRunRemoteConnecting,
    setFirstRunRemoteConnected,
    setFirstRunRemoteError,
    setFirstRunRemoteToken,
  ]);

  // ── revertFirstRun / handleFirstRunBack ──────────────────────

  const revertFirstRun = useCallback(() => {
    const previousStep = resolveSetupPreviousStep(setupStep);

    if (!previousStep) return;
    if (setupStep === "model") {
      applyResetConnectionWizardToHostingStep();
    }
    setSetupStep(previousStep);
    setFirstRunActiveGuide(
      firstRunMode === "advanced"
        ? getFlaminaTopicForSetupStep(previousStep)
        : null,
    );
  }, [
    applyResetConnectionWizardToHostingStep,
    firstRunMode,
    setupStep,
    setFirstRunActiveGuide,
    setSetupStep,
  ]);

  const handleFirstRunBack = revertFirstRun;

  // ── handleFirstRunJumpToStep ───────────────────────────────────

  const handleFirstRunJumpToStep = useCallback(
    (target: SetupStep) => {
      if (!canRevertSetupTo({ current: setupStep, target })) return;
      const currentStepIndex = getSetupStepIndex(setupStep);
      const targetStepIndex = getSetupStepIndex(target);
      const modelStepIndex = getSetupStepIndex("model");

      if (
        currentStepIndex >= modelStepIndex &&
        targetStepIndex < modelStepIndex
      ) {
        applyResetConnectionWizardToHostingStep();
      }
      if (target === "connection") {
        persistMobileRuntimeModeForServerTarget("");
        setFirstRunRuntimeTarget("");
      }
      setSetupStep(target);
      setFirstRunActiveGuide(
        firstRunMode === "advanced"
          ? getFlaminaTopicForSetupStep(target)
          : null,
      );
    },
    [
      applyResetConnectionWizardToHostingStep,
      firstRunMode,
      setupStep,
      setSetupStep,
      setFirstRunActiveGuide,
      setFirstRunRuntimeTarget,
    ],
  );

  // ── handleFirstRunUseLocalBackend ──────────────────────────────

  const handleFirstRunUseLocalBackend = useCallback(() => {
    forceLocalBootstrapRef.current = true;
    clearPersistedActiveServer();
    client.setBaseUrl(null);
    client.setToken(null);
    setFirstRunRemoteConnecting(false);
    setFirstRunRemoteError(null);
    setFirstRunRemoteConnected(false);
    setFirstRunRemoteApiBase("");
    setFirstRunRemoteToken("");
    persistMobileRuntimeModeForServerTarget("");
    setFirstRunRuntimeTarget("");
    setActionNotice(
      "Checking this device for an existing Eliza setup...",
      "info",
      3200,
    );
    retryStartup();
  }, [
    retryStartup,
    setActionNotice,
    forceLocalBootstrapRef,
    setFirstRunRemoteApiBase,
    setFirstRunRemoteConnected,
    setFirstRunRemoteConnecting,
    setFirstRunRemoteError,
    setFirstRunRemoteToken,
    setFirstRunRuntimeTarget,
    client,
  ]);

  // ── handleFirstRunRemoteConnect ────────────────────────────────

  const handleFirstRunRemoteConnect = useCallback(async () => {
    if (firstRunRemoteConnecting) return;
    let normalizedBase = "";
    try {
      normalizedBase = normalizeRemoteApiBaseInput(firstRunRemoteApiBase);
    } catch (err) {
      setFirstRunRemoteError(
        err instanceof Error ? err.message : "Enter a valid backend address.",
      );
      return;
    }

    const accessKey = firstRunRemoteToken.trim();
    const probe = new ElizaClient(normalizedBase, accessKey || undefined);
    setFirstRunRemoteConnecting(true);
    setFirstRunRemoteError(null);
    try {
      const auth = await probe.getAuthStatus();
      if (auth.required && !accessKey) {
        throw new Error("This backend requires an access key.");
      }
      await probe.getFirstRunStatus();
      savePersistedActiveServer(
        createPersistedActiveServer({
          kind: "remote",
          apiBase: normalizedBase,
          ...(accessKey ? { accessToken: accessKey } : {}),
        }),
      );
      persistMobileRuntimeModeForServerTarget("remote");
      setFirstRunRuntimeTarget("remote");
      setFirstRunRemoteApiBase(normalizedBase);
      setFirstRunRemoteToken(accessKey);
      setFirstRunRemoteConnected(true);
      setActionNotice("Connected to remote backend.", "success", 4200);
      retryStartup();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to reach remote backend.";
      const normalizedMessage =
        /401|unauthorized|forbidden/i.test(message) && accessKey
          ? "Access key rejected. Check the address and try again."
          : message;
      setFirstRunRemoteError(normalizedMessage);
    } finally {
      setFirstRunRemoteConnecting(false);
    }
  }, [
    firstRunRemoteApiBase,
    firstRunRemoteConnecting,
    firstRunRemoteToken,
    retryStartup,
    setActionNotice,
    setFirstRunRemoteApiBase,
    setFirstRunRemoteConnected,
    setFirstRunRemoteConnecting,
    setFirstRunRemoteError,
    setFirstRunRemoteToken,
    setFirstRunRuntimeTarget,
  ]);

  // ── applyDetectedProviders ───────────────────────────────────────

  const applyDetectedProviders = useCallback(
    (detected: Awaited<ReturnType<typeof scanProviderCredentials>>) => {
      setFirstRunDetectedProviders(
        detected as typeof detected & AppState["firstRunDetectedProviders"],
      );
    },
    [setFirstRunDetectedProviders],
  );

  return {
    completeFirstRun,
    goToFirstRunStep,
    applyResetConnectionWizardToHostingStep,
    revertFirstRun,
    handleFirstRunBack,
    handleFirstRunJumpToStep,
    handleFirstRunUseLocalBackend,
    handleFirstRunRemoteConnect,
    applyDetectedProviders,
  };
}
