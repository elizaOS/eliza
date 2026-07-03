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
import { Lock } from "lucide-react";
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

/**
 * Standard fallback for an OWNER-tier surface a lower-tier caller reached
 * (#12087 Item 24). Kept unobtrusive — a lock glyph + one muted line — so the
 * gated surface reads as "not yours" rather than "broken".
 */
export function OwnerOnlyNotice({
  message = "This section is available to the workspace owner only.",
}: {
  message?: string;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-sm border border-border/45 bg-card/30 px-3 py-6 text-xs text-muted">
      <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{message}</span>
    </div>
  );
}
