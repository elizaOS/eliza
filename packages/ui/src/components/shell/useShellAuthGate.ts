/**
 * React binding for {@link deriveShellAuthGate}: branding `cloudOnly` plus the
 * shared auth snapshot, with no extra network traffic.
 *
 * Subscribe-only (`observeOnly`) so the pill can read the app-level
 * `/api/auth/me` probe. The first-run conductor still owns the first sign-in
 * card; this hook is the resting / recovery gate after that card is closed.
 */

import { useBranding } from "../../config/branding";
import { useAuthStatus } from "../../hooks/useAuthStatus";
import { deriveShellAuthGate, type ShellAuthGate } from "./shell-auth-gate";

export function useShellAuthGate(): ShellAuthGate {
  const { cloudOnly } = useBranding();
  const { state } = useAuthStatus({ observeOnly: true });
  return deriveShellAuthGate({
    cloudOnly: cloudOnly === true,
    authPhase: state.phase,
  });
}

export type { ShellAuthGate, ShellAuthGatePhase } from "./shell-auth-gate";
