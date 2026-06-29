/**
 * RoleGate — declarative role gating for the UI (#9948).
 *
 * Renders its children only when the current `useRole()` role satisfies the
 * gate, otherwise renders `fallback` (nothing by default). Ranking goes through
 * the canonical `satisfiesRoleGate` primitive — the same one the server action /
 * provider gates use — so a developer-only surface is expressed once:
 *
 *   <RoleGate minRole="OWNER"><WalletPanel /></RoleGate>
 */

import { type RoleGateRole, satisfiesRoleGate } from "@elizaos/core";
import type { ReactNode } from "react";
import { useRole } from "../hooks/useRole.tsx";

export interface RoleGateProps {
  /** Minimum role by rank (e.g. "OWNER", "ADMIN"). */
  minRole?: RoleGateRole;
  /** Any one of these roles passes. */
  anyOf?: RoleGateRole[];
  /** Any of these roles denies (overrides minRole/anyOf). */
  noneOf?: RoleGateRole[];
  /** Rendered when the gate passes. */
  children: ReactNode;
  /** Rendered when the gate fails. Defaults to nothing. */
  fallback?: ReactNode;
}

export function RoleGate({
  minRole,
  anyOf,
  noneOf,
  children,
  fallback = null,
}: RoleGateProps): React.JSX.Element {
  const { role } = useRole();
  const allowed = satisfiesRoleGate([role], { minRole, anyOf, noneOf });
  return <>{allowed ? children : fallback}</>;
}
