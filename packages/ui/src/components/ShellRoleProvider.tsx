/** Applies the authenticated server role to the shell; missing or invalid roles are GUEST. */

import type { RoleGateRole } from "@elizaos/core";
import { ROLE_RANK } from "@elizaos/core/protocol";
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

export function deriveShellRole(state: AuthStatusLike): RoleGateRole {
  if (state.phase !== "authenticated") return "GUEST";
  const serverRole = state.access?.role;
  if (typeof serverRole === "string" && CANONICAL_ROLES.has(serverRole)) {
    return serverRole as RoleGateRole;
  }
  return "GUEST";
}

export function ShellRoleProvider({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const { state } = useAuthStatus({ observeOnly: true });
  return <RoleProvider role={deriveShellRole(state)}>{children}</RoleProvider>;
}
