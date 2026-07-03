/**
 * First-run state — consolidated via useReducer.
 *
 * Replaces 35+ individual useState hooks with structured reducers.
 * Connector tokens (telegram, discord, etc.) collapse into a single Record.
 * Remote connection state (connecting/connected/error) collapses into one object.
 */

import {
  DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
  getDefaultStylePreset,
} from "@elizaos/shared";
import { useCallback, useReducer, useRef } from "react";
import type { FirstRunOptions } from "../api";
import { readPersistedMobileRuntimeMode } from "../first-run/mobile-runtime-mode";
import {
  activeServerKindToFirstRunRuntimeTarget,
  type FirstRunRuntimeTarget,
} from "../first-run/runtime-target";
import { canRunLocal } from "../platform/init";
import {
  loadPersistedActiveServer,
  loadPersistedFirstRunComplete,
  loadPersistedSetupStep,
  saveSetupStep,
} from "./persistence";
import type { AppState, SetupStep } from "./types";

// ── Connector token keys ───────────────────────────────────────────────

export type ConnectorTokenKey =
  | "telegramToken"
  | "discordToken"
  | "whatsAppSessionPath"
  | "twilioAccountSid"
  | "twilioAuthToken"
  | "twilioPhoneNumber"
  | "blooioApiKey"
  | "blooioPhoneNumber"
  | "githubToken";

// ── Remote connection state ────────────────────────────────────────────

export interface RemoteConnectionState {
  status: "idle" | "connecting" | "connected" | "error";
  error: string | null;
}

// ── State shape ────────────────────────────────────────────────────────

export interface FirstRunState {
  step: SetupStep;
  mode: AppState["firstRunMode"];
  activeGuide: string | null;
  deferredTasks: string[];
  postChecklistDismissed: boolean;
  options: FirstRunOptions | null;

  // Identity
  name: string;
  ownerName: string;
  style: string;
  avatar: number;

  // Hosting
  serverTarget: FirstRunRuntimeTarget;
  cloudApiKey: string;

  // Provider
  provider: string;
  apiKey: string;
  voiceProvider: string;
  voiceApiKey: string;
  nanoModel: string;
  smallModel: string;
  mediumModel: string;
  largeModel: string;
  megaModel: string;
  openRouterModel: string;
  primaryModel: string;
  existingInstallDetected: boolean;
  detectedProviders: AppState["firstRunDetectedProviders"];

  // Connector tokens (consolidated)
  connectorTokens: Record<ConnectorTokenKey, string>;

  // Remote connection
  remote: RemoteConnectionState;
  remoteApiBase: string;
  remoteToken: string;

  // Tabs
  subscriptionTab: "token" | "oauth";
  elizaCloudTab: "login" | "apikey";

  // Chain / RPC
  selectedChains: Set<string>;
  rpcSelections: Record<string, string>;
  rpcKeys: Record<string, string>;

  // Features (connectors / capabilities toggle step)
  featureTelegram: boolean;
  featureDiscord: boolean;
  featurePhone: boolean;
  featureCrypto: boolean;
  featureBrowser: boolean;
  featureComputerUse: boolean;
  featureOAuthPending: string | null;

  // Misc
  restarting: boolean;
  cloudProvisionedContainer: boolean;
}

function isRemoteApiBase(baseUrl: string): boolean {
  if (!baseUrl || typeof window === "undefined") return false;
  try {
    const parsed = new URL(baseUrl);
    return (
      parsed.hostname !== window.location.hostname &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "127.0.0.1" &&
      parsed.hostname !== "::1"
    );
  } catch {
    return false;
  }
}

const EMPTY_TOKENS: Record<ConnectorTokenKey, string> = {
  telegramToken: "",
  discordToken: "",
  whatsAppSessionPath: "",
  twilioAccountSid: "",
  twilioAuthToken: "",
  twilioPhoneNumber: "",
  blooioApiKey: "",
  blooioPhoneNumber: "",
  githubToken: "",
};

function loadInitialServerSelection(): Pick<
  FirstRunState,
  "serverTarget" | "remote" | "remoteApiBase" | "remoteToken"
> {
  const activeServer = loadPersistedActiveServer();
  if (!activeServer) {
    return {
      serverTarget: "",
      remote: {
        status: "idle",
        error: null,
      },
      remoteApiBase: "",
      remoteToken: "",
    };
  }

  if (activeServer.kind === "local") {
    return {
      serverTarget: activeServerKindToFirstRunRuntimeTarget(activeServer.kind),
      remote: {
        status: "idle",
        error: null,
      },
      remoteApiBase: "",
      remoteToken: "",
    };
  }

  if (activeServer.kind === "cloud") {
    const serverTarget =
      readPersistedMobileRuntimeMode() === "cloud-hybrid"
        ? "elizacloud-hybrid"
        : activeServerKindToFirstRunRuntimeTarget(activeServer.kind);
    return {
      serverTarget,
      remote: {
        status: "idle",
        error: null,
      },
      remoteApiBase: "",
      remoteToken: activeServer.accessToken?.trim() ?? "",
    };
  }

  const apiBase = activeServer.apiBase?.trim() ?? "";
  return {
    serverTarget: activeServerKindToFirstRunRuntimeTarget(activeServer.kind),
    remote: {
      status: isRemoteApiBase(apiBase) ? "connected" : "idle",
      error: null,
    },
    remoteApiBase: apiBase,
    remoteToken: activeServer.accessToken?.trim() ?? "",
  };
}

function createInitialState(cloudOnly?: boolean): FirstRunState {
  const defaultStyle = getDefaultStylePreset();
  const initialServer = loadInitialServerSelection();
  const initialServerTarget = cloudOnly
    ? readPersistedMobileRuntimeMode() === "cloud-hybrid"
      ? "elizacloud-hybrid"
      : "elizacloud"
    : initialServer.serverTarget;

  const persistedStep = loadPersistedSetupStep();
  const skipConnection = canRunLocal();

  let step = persistedStep ?? (skipConnection ? "model" : "connection");
  if (skipConnection && step === "connection") {
    step = "model";
  }

  const serverTarget =
    initialServerTarget || (skipConnection && step === "model" ? "local" : "");

  return {
    step,
    mode: "basic",
    activeGuide: null,
    deferredTasks: [],
    postChecklistDismissed: false,
    options: null,
    name: defaultStyle.name,
    ownerName: "anon",
    style: defaultStyle.id,
    avatar: defaultStyle.avatarIndex,
    serverTarget,
    cloudApiKey: "",
    provider: "",
    apiKey: "",
    voiceProvider: "",
    voiceApiKey: "",
    nanoModel: DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
    smallModel: DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
    mediumModel: DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
    largeModel: DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
    megaModel: DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
    openRouterModel: "",
    primaryModel: "",
    existingInstallDetected: false,
    detectedProviders: [],
    connectorTokens: { ...EMPTY_TOKENS },
    remote: initialServer.remote,
    remoteApiBase: initialServer.remoteApiBase,
    remoteToken: initialServer.remoteToken,
    subscriptionTab: "token",
    elizaCloudTab: "login",
    selectedChains: new Set(["evm", "solana"]),
    rpcSelections: {},
    rpcKeys: {},
    featureTelegram: false,
    featureDiscord: false,
    featurePhone: false,
    featureCrypto: true,
    featureBrowser: true,
    featureComputerUse: false,
    featureOAuthPending: null,
    restarting: false,
    cloudProvisionedContainer: false,
  };
}

// ── Actions ────────────────────────────────────────────────────────────

type FirstRunAction =
  | { type: "SET_STEP"; step: SetupStep }
  | { type: "SET_MODE"; mode: AppState["firstRunMode"] }
  | { type: "SET_ACTIVE_GUIDE"; guide: string | null }
  | { type: "ADD_DEFERRED_TASK"; task: string }
  | { type: "SET_DEFERRED_TASKS"; tasks: string[] }
  | { type: "SET_POST_CHECKLIST_DISMISSED"; value: boolean }
  | { type: "SET_OPTIONS"; options: FirstRunOptions | null }
  | { type: "SET_FIELD"; field: string; value: unknown }
  | { type: "SET_CONNECTOR_TOKEN"; key: ConnectorTokenKey; value: string }
  | {
      type: "SET_REMOTE_STATUS";
      status: RemoteConnectionState["status"];
      error?: string | null;
    }
  | { type: "SET_REMOTE_API_BASE"; value: string }
  | { type: "SET_REMOTE_TOKEN"; value: string }
  | {
      type: "SET_DETECTED_PROVIDERS";
      value: AppState["firstRunDetectedProviders"];
    }
  | { type: "RESET_FOR_NEW_FIRST_RUN" };

function firstRunReducer(
  state: FirstRunState,
  action: FirstRunAction,
): FirstRunState {
  switch (action.type) {
    case "SET_STEP":
      return { ...state, step: action.step };
    case "SET_MODE":
      return { ...state, mode: action.mode };
    case "SET_ACTIVE_GUIDE":
      return { ...state, activeGuide: action.guide };
    case "ADD_DEFERRED_TASK":
      if (state.deferredTasks.includes(action.task)) return state;
      return {
        ...state,
        deferredTasks: [...state.deferredTasks, action.task],
        postChecklistDismissed: false,
      };
    case "SET_DEFERRED_TASKS":
      return {
        ...state,
        deferredTasks: [...new Set(action.tasks)],
      };
    case "SET_POST_CHECKLIST_DISMISSED":
      return { ...state, postChecklistDismissed: action.value };
    case "SET_OPTIONS":
      return { ...state, options: action.options };
    case "SET_FIELD": {
      if (action.field === "serverTarget") {
        return {
          ...state,
          serverTarget: action.value as FirstRunRuntimeTarget,
        };
      }

      return { ...state, [action.field]: action.value };
    }
    case "SET_CONNECTOR_TOKEN":
      return {
        ...state,
        connectorTokens: {
          ...state.connectorTokens,
          [action.key]: action.value,
        },
      };
    case "SET_REMOTE_STATUS":
      return {
        ...state,
        remote: { status: action.status, error: action.error ?? null },
      };
    case "SET_REMOTE_API_BASE":
      return { ...state, remoteApiBase: action.value };
    case "SET_REMOTE_TOKEN":
      return { ...state, remoteToken: action.value };
    case "SET_DETECTED_PROVIDERS":
      return { ...state, detectedProviders: action.value };
    case "RESET_FOR_NEW_FIRST_RUN":
      return createInitialState();
    default:
      return state;
  }
}

// ── Hook ───────────────────────────────────────────────────────────────

export interface FirstRunStateHook {
  state: FirstRunState;
  dispatch: React.Dispatch<FirstRunAction>;

  setStep: (step: SetupStep) => void;
  setMode: (mode: AppState["firstRunMode"]) => void;
  setActiveGuide: (guide: string | null) => void;
  addDeferredTask: (task: string) => void;
  setDeferredTasks: (tasks: string[]) => void;
  setOptions: (options: FirstRunOptions | null) => void;
  setField: (field: string, value: unknown) => void;
  setConnectorToken: (key: ConnectorTokenKey, value: string) => void;
  setRemoteStatus: (
    status: RemoteConnectionState["status"],
    error?: string | null,
  ) => void;
  setDetectedProviders: (value: AppState["firstRunDetectedProviders"]) => void;

  /** Tracks whether first-run completion has been committed this session. */
  completionCommittedRef: React.RefObject<boolean>;
  /** Force local bootstrap ref. */
  forceLocalBootstrapRef: React.RefObject<boolean>;
}

export function useFirstRunState(cloudOnly?: boolean): FirstRunStateHook {
  const [state, dispatch] = useReducer(firstRunReducer, cloudOnly, (co) =>
    createInitialState(co),
  );

  // Rehydrate from the durable completion flag (issue #11506): a fresh app
  // process (mobile relaunch / desktop restart) starts with no in-memory
  // completion state, so without this the ref would read false and the startup
  // coordinator would fall back to re-probing / re-prompting onboarding when
  // the server status is briefly unavailable. Seeding from the persisted flag
  // keeps a completed onboarding committed across a process restart, coherent
  // with the `hadPrior` protection the restore/poll phases read from the same
  // durable store.
  const completionCommittedRef = useRef(loadPersistedFirstRunComplete());
  const forceLocalBootstrapRef = useRef(false);

  const setStep = useCallback((step: SetupStep) => {
    dispatch({ type: "SET_STEP", step });
    saveSetupStep(step);
  }, []);

  const setMode = useCallback((mode: AppState["firstRunMode"]) => {
    dispatch({ type: "SET_MODE", mode });
  }, []);

  const setActiveGuide = useCallback((guide: string | null) => {
    dispatch({ type: "SET_ACTIVE_GUIDE", guide });
  }, []);

  const addDeferredTask = useCallback((task: string) => {
    dispatch({ type: "ADD_DEFERRED_TASK", task });
  }, []);

  const setDeferredTasks = useCallback((tasks: string[]) => {
    dispatch({ type: "SET_DEFERRED_TASKS", tasks });
  }, []);

  const setOptions = useCallback((options: FirstRunOptions | null) => {
    dispatch({ type: "SET_OPTIONS", options });
  }, []);

  const setField = useCallback((field: string, value: unknown) => {
    dispatch({ type: "SET_FIELD", field, value });
  }, []);

  const setConnectorToken = useCallback(
    (key: ConnectorTokenKey, value: string) => {
      dispatch({ type: "SET_CONNECTOR_TOKEN", key, value });
    },
    [],
  );

  const setRemoteStatus = useCallback(
    (status: RemoteConnectionState["status"], error?: string | null) => {
      dispatch({ type: "SET_REMOTE_STATUS", status, error });
    },
    [],
  );

  const setDetectedProviders = useCallback(
    (value: AppState["firstRunDetectedProviders"]) => {
      dispatch({ type: "SET_DETECTED_PROVIDERS", value });
    },
    [],
  );

  return {
    state,
    dispatch,
    setStep,
    setMode,
    setActiveGuide,
    addDeferredTask,
    setDeferredTasks,
    setOptions,
    setField,
    setConnectorToken,
    setRemoteStatus,
    setDetectedProviders,
    completionCommittedRef,
    forceLocalBootstrapRef,
  };
}

export type { FirstRunAction as FirstRunDispatchAction };
