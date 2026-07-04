/**
 * First-run state reducer — the surviving cross-surface fields only.
 *
 * The in-chat onboarding conductor (`first-run/use-first-run-conductor.ts`)
 * owns the flow itself; this reducer holds what other surfaces read or the
 * finish path writes: the agent name/style (content packs), first-run options
 * (character editor presets), the persisted runtime target + provider, the
 * remote-connection fields (CONNECT_EVENT deep link), the post-onboarding
 * deferred-task checklist, and the cloud-provisioned-container skip guard.
 * The deleted wizard's 35+ step/connector/feature fields died with it (#12178).
 */

import { getDefaultStylePreset } from "@elizaos/shared";
import { useReducer, useRef } from "react";
import type { FirstRunOptions } from "../api";
import { readPersistedMobileRuntimeMode } from "../first-run/mobile-runtime-mode";
import {
  activeServerKindToFirstRunRuntimeTarget,
  type FirstRunRuntimeTarget,
} from "../first-run/runtime-target";
import {
  loadPersistedActiveServer,
  loadPersistedFirstRunComplete,
} from "./persistence";

// ── Remote connection state ────────────────────────────────────────────

export interface RemoteConnectionState {
  status: "idle" | "connecting" | "connected" | "error";
  error: string | null;
}

// ── State shape ────────────────────────────────────────────────────────

export interface FirstRunState {
  deferredTasks: string[];
  postChecklistDismissed: boolean;
  options: FirstRunOptions | null;

  // Identity
  name: string;
  style: string;

  // Hosting
  serverTarget: FirstRunRuntimeTarget;

  // Provider
  provider: string;

  // Remote connection
  remote: RemoteConnectionState;
  remoteApiBase: string;
  remoteToken: string;

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
    // error-policy:J3 unparseable base URL cannot be classified as remote —
    // treat as local so the flow stays on the safe default.
    return false;
  }
}

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

  return {
    deferredTasks: [],
    postChecklistDismissed: false,
    options: null,
    name: defaultStyle.name,
    style: defaultStyle.id,
    serverTarget: initialServerTarget,
    provider: "",
    remote: initialServer.remote,
    remoteApiBase: initialServer.remoteApiBase,
    remoteToken: initialServer.remoteToken,
    cloudProvisionedContainer: false,
  };
}

// ── Actions ────────────────────────────────────────────────────────────

type FirstRunAction =
  | { type: "ADD_DEFERRED_TASK"; task: string }
  | { type: "SET_DEFERRED_TASKS"; tasks: string[] }
  | { type: "SET_POST_CHECKLIST_DISMISSED"; value: boolean }
  | { type: "SET_OPTIONS"; options: FirstRunOptions | null }
  | { type: "SET_FIELD"; field: string; value: unknown }
  | {
      type: "SET_REMOTE_STATUS";
      status: RemoteConnectionState["status"];
      error?: string | null;
    }
  | { type: "SET_REMOTE_API_BASE"; value: string }
  | { type: "SET_REMOTE_TOKEN"; value: string }
  | { type: "RESET_FOR_NEW_FIRST_RUN" };

function firstRunReducer(
  state: FirstRunState,
  action: FirstRunAction,
): FirstRunState {
  switch (action.type) {
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
    case "SET_REMOTE_STATUS":
      return {
        ...state,
        remote: { status: action.status, error: action.error ?? null },
      };
    case "SET_REMOTE_API_BASE":
      return { ...state, remoteApiBase: action.value };
    case "SET_REMOTE_TOKEN":
      return { ...state, remoteToken: action.value };
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

  /** Tracks whether first-run completion has been committed durably. */
  completionCommittedRef: React.RefObject<boolean>;
  /** One-shot in-memory handoff for post-onboarding landing behavior. */
  completionJustCommittedRef: React.RefObject<boolean>;
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
  const completionJustCommittedRef = useRef(false);

  return {
    state,
    dispatch,
    completionCommittedRef,
    completionJustCommittedRef,
  };
}

export type { FirstRunAction as FirstRunDispatchAction };
