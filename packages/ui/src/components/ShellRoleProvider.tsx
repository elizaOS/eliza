/**
 * ShellRoleProvider (#9948) — wires the canonical `RoleProvider` into the app
 * shell once, deriving the current role from the existing auth status. Drop it
 * around the shell content so any descendant can use `useRole()` / `<RoleGate>`.
 *
 * It observes the app-level auth check (`observeOnly` → no extra poll) and maps
 * it to a canonical role. This is the interim derivation until `/api/auth/me`
 * returns the server-resolved boundary role (the same tier `resolveBoundaryRole`
 * computes in app-core); when that lands, only `deriveShellRole` changes.
 */

import type { RoleGateRole } from "@elizaos/core";
import type { ReactNode } from "react";
import { useAuthStatus } from "../hooks/useAuthStatus.ts";
import { RoleProvider } from "../hooks/useRole.tsx";

type AuthStatusLike = {
  phase: string;
  access?: { mode?: string };
};

/**
 * Pure mapping from auth status → canonical role. Local/loopback access is the
 * deployed-app owner (matching the server boundary); an authenticated remote /
 * session caller is treated as USER until the server surfaces its real role;
 * anything else is GUEST (fail low — never leak gated UI).
 */
export function deriveShellRole(state: AuthStatusLike): RoleGateRole {
  if (state.phase !== "authenticated") return "GUEST";
  if (state.access?.mode === "local") return "OWNER";
  return "USER";
}

export function ShellRoleProvider({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const { state } = useAuthStatus({ observeOnly: true });
  return <RoleProvider role={deriveShellRole(state)}>{children}</RoleProvider>;
}
