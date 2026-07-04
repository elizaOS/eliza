/**
 * The single canonical role-gating primitive for the UI (#9948).
 *
 * One context + hook so "user can chat but not see the wallet" is expressible
 * declaratively, ranked by the SAME canonical role model the server uses
 * (`roleRank` over the canonical rank table) — surfaces gate through this rather
 * than pulling their own `isOwner` boolean from a per-surface endpoint.
 *
 * The app populates `RoleProvider` from whatever authoritative signal it has
 * (the server-resolved boundary role, or the owner flag); components below it
 * just read `useRole()` / wrap in `<RoleGate>`.
 */

import { type RoleGateRole, roleRank } from "@elizaos/core";
import { createContext, type ReactNode, useContext, useMemo } from "react";

/** Default to the lowest tier so a missing provider never leaks gated UI. */
const RoleContext = createContext<RoleGateRole>("GUEST");

export function RoleProvider({
  role,
  children,
}: {
  role: RoleGateRole;
  children: ReactNode;
}): React.JSX.Element {
  return <RoleContext.Provider value={role}>{children}</RoleContext.Provider>;
}

export interface UseRoleResult {
  /** The current canonical role. */
  role: RoleGateRole;
  /** True for OWNER. */
  isOwner: boolean;
  /** True for ADMIN or OWNER. */
  isAdmin: boolean;
  /** True when the current role ranks at or above `min`. */
  atLeast: (min: RoleGateRole) => boolean;
}

export function useRole(): UseRoleResult {
  const role = useContext(RoleContext);
  return useMemo(() => {
    const rank = roleRank(role);
    return {
      role,
      isOwner: rank >= roleRank("OWNER"),
      isAdmin: rank >= roleRank("ADMIN"),
      atLeast: (min: RoleGateRole) => rank >= roleRank(min),
    };
  }, [role]);
}
