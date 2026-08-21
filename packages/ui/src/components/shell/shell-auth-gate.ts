/**
 * Pure auth-gate decision for the desktop home pill on cloud-only builds.
 *
 * Local-runtime products inject an owner API key before React mounts, so a raw
 * `authenticated` probe is not "signed in to Cloud". The gate therefore applies
 * only when branding `cloudOnly` is true; every other build leaves the pill
 * machine unchanged.
 */

import type { AuthStatusState } from "../../hooks/useAuthStatus";
import type { ShellPhase } from "./shell-state";

/** Discriminated rest-state of the cloud-only pill auth gate. */
export type ShellAuthGatePhase =
  | "checking"
  | "unavailable"
  | "needs-auth"
  | "clear";

export interface ShellAuthGate {
  /** True while capture, overlay summon, and hotkeys must not run. */
  gated: boolean;
  phase: ShellAuthGatePhase;
}

export interface DeriveShellAuthGateInput {
  cloudOnly: boolean;
  authPhase: AuthStatusState["phase"];
  hasUsableCloudSession: boolean;
}

export interface DeriveShellPhaseInput {
  ready: boolean;
  recording: boolean;
  realtimeVoiceListening: boolean;
  sttPending: boolean;
  responding: boolean;
  isOpen: boolean;
  authGate: ShellAuthGatePhase;
}

/**
 * Compose branding + the shared auth snapshot into the pill gate.
 *
 * A cloud-only desktop requires the canonical Steward session token in
 * addition to a successful backend auth probe. Without that token, a local
 * owner credential can make `/api/auth/me` look authenticated even though the
 * user has never signed in to Cloud. A present token remains gated on
 * `checking` while the probe is unresolved or unavailable.
 */
export function deriveShellAuthGate(
  input: DeriveShellAuthGateInput,
): ShellAuthGate {
  if (!input.cloudOnly) {
    return { gated: false, phase: "clear" };
  }
  if (!input.hasUsableCloudSession) {
    return { gated: true, phase: "needs-auth" };
  }
  if (input.authPhase === "authenticated") {
    return { gated: false, phase: "clear" };
  }
  if (input.authPhase === "unauthenticated") {
    return { gated: true, phase: "needs-auth" };
  }
  if (input.authPhase === "server_unavailable") {
    return { gated: true, phase: "unavailable" };
  }
  return { gated: true, phase: "checking" };
}

/**
 * Derive the pill phase. `needs-auth` sits above the live waterfall so a
 * signed-out cloud-only pill cannot grow into the waveform chip. `checking`
 * only holds the closed launcher on `booting` — an already-open overlay stays
 * summoned, matching the pre-gate rule that `booting` is the closed rest
 * state.
 */
export function deriveShellPhase(input: DeriveShellPhaseInput): ShellPhase {
  if (input.authGate === "needs-auth") {
    return "needs-auth";
  }
  if (
    (input.authGate === "checking" || input.authGate === "unavailable") &&
    !input.isOpen &&
    !input.recording &&
    !input.realtimeVoiceListening &&
    !input.sttPending &&
    !input.responding
  ) {
    return "booting";
  }
  if (input.recording || input.realtimeVoiceListening) {
    return "listening";
  }
  if (input.sttPending) {
    return "processing";
  }
  if (input.responding) {
    return "responding";
  }
  if (input.isOpen) {
    return "summoned";
  }
  return input.ready ? "idle" : "booting";
}
