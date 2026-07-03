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

import { ROLE_RANK, type RoleGateRole } from "@elizaos/core";
import type { ReactNode } from "react";
import { useAuthStatus } from "../hooks/useAuthStatus.ts";
import { RoleProvider } from "../hooks/useRole.tsx";

type AuthStatusLike = {
  phase: string;
  access?: { mode?: string; role?: string };
};

/**
 * The accepted canonical role set (#12087 Item 28). Derived from core's
 * {@link ROLE_RANK} so there is one source of truth for which tier strings the
 * UI recognizes — a role added to the core rank table is recognized here with
 * no edit to this file.
 */
const CANONICAL_ROLES = new Set<string>(Object.keys(ROLE_RANK));

/**
 * Pure mapping from auth status → canonical role. Prefers the server-authoritative
 * `access.role` from `/api/auth/me` (#9948); falls back to the mode-based
 * interim for older backends that don't surface a role (local/loopback access is
 * the deployed-app owner, an authenticated remote/session caller is USER).
 * Anything unauthenticated is GUEST (fail low — never leak gated UI).
 */
export function deriveShellRole(state: AuthStatusLike): RoleGateRole {
  if (state.phase !== "authenticated") return "GUEST";
  const serverRole = state.access?.role;
  if (typeof serverRole === "string" && CANONICAL_ROLES.has(serverRole)) {
    return serverRole as RoleGateRole;
  }
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
