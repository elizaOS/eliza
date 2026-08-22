/**
 * Static device × backend × auth-mode support matrix for multi-subscription
 * coding-agent orchestration. Single checked-in source of truth that mirrors
 * the live gate (`detectOrchestratorTerminalSupport` /
 * `classifyTerminalSupport` in terminal-capabilities.ts) — see issue #9146.
 *
 * Each row's `support` is computed by the SAME pure classifier the runtime
 * uses, so this object cannot silently drift from the gate: a change to the
 * device gating that affects any documented profile fails this package's tests.
 *
 * Backend → auth-mode reach comes from the cross-runtime shared capability
 * contract also consumed by the app-core account bridge. When a device
 * supports coding agents, every backend below is reachable on it; when
 * unsupported, none are.
 */

import {
  CODING_AGENT_BACKEND_PROVIDERS,
  CODING_AGENT_BACKENDS,
  type CodingAgentBackend,
} from "@elizaos/shared";
import {
  classifyTerminalSupport,
  type OrchestratorTerminalSupport,
  type TerminalSupportEnv,
} from "./terminal-capabilities.js";

/** Coding backends with a first-party spawnable CLI (post #9167 cleanup). */
export const ORCHESTRATOR_BACKENDS = CODING_AGENT_BACKENDS;
export type OrchestratorBackend = CodingAgentBackend;

/** Ordered auth modes per backend; subscription is preferred over API key. */
export const ORCHESTRATOR_BACKEND_AUTH: Readonly<
  Record<OrchestratorBackend, readonly string[]>
> = ORCHESTRATOR_BACKENDS.reduce(
  (authModes, backend) => {
    authModes[backend] =
      CODING_AGENT_BACKEND_PROVIDERS[backend].length > 0
        ? CODING_AGENT_BACKEND_PROVIDERS[backend]
        : ["runtime-routed"];
    return authModes;
  },
  {} as Record<OrchestratorBackend, readonly string[]>,
);

export interface DeviceSupportProfile {
  /** Stable id for the device/runtime profile. */
  id: string;
  /** Human-readable description for the support-matrix doc. */
  label: string;
  /** The env snapshot that characterizes this profile. */
  env: TerminalSupportEnv;
  /** For Android profiles, whether a staged shell is present. */
  androidShellAvailable?: boolean;
}

/** Documented device/runtime profiles, mirroring terminal-capabilities.ts. */
export const ORCHESTRATOR_DEVICE_PROFILES: readonly DeviceSupportProfile[] = [
  {
    id: "desktop",
    label: "Desktop / server (Node, non-store)",
    env: {},
  },
  {
    id: "ios",
    label: "iOS (vanilla mobile runtime)",
    env: { platform: "ios" },
  },
  {
    id: "store",
    label: "Store build (sandboxed distribution)",
    env: { buildVariant: "store" },
  },
  {
    id: "android-store",
    label: "Android Play/store build (not local-yolo)",
    env: { platform: "android" },
  },
  {
    id: "android-local-yolo",
    label: "Android direct/AOSP local-yolo with staged shell",
    env: { platform: "android", runtimeMode: "local-yolo" },
    androidShellAvailable: true,
  },
];

export interface DeviceSupportMatrixRow {
  id: string;
  label: string;
  support: OrchestratorTerminalSupport;
  /** Backends reachable on this device (all when supported, none otherwise). */
  backends: readonly OrchestratorBackend[];
}

/** Compute the full matrix through the same pure gate the runtime uses. */
export function buildOrchestratorDeviceSupportMatrix(): DeviceSupportMatrixRow[] {
  return ORCHESTRATOR_DEVICE_PROFILES.map((profile) => {
    const support = classifyTerminalSupport(profile.env, {
      androidShellAvailable: profile.androidShellAvailable,
    });
    return {
      id: profile.id,
      label: profile.label,
      support,
      backends: support.supported ? ORCHESTRATOR_BACKENDS : [],
    };
  });
}

/** Eagerly-evaluated matrix snapshot for docs/consumers. */
export const ORCHESTRATOR_DEVICE_SUPPORT_MATRIX: readonly DeviceSupportMatrixRow[] =
  buildOrchestratorDeviceSupportMatrix();
