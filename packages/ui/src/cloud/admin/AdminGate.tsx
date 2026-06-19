/**
 * Role gate + chrome for the in-app Eliza Cloud admin surfaces.
 *
 * Every admin route (`/dashboard/admin*`) wraps its body in {@link AdminGate}.
 * In `@elizaos/cloud-frontend` this lived in `dashboard/admin/Layout.tsx` as a
 * nested-route `<Outlet>` parent; the app shell mounts each cloud route flat
 * against the route registry (no shared `<Outlet>` parent), so the gate is a
 * component each route composes with instead.
 *
 * Gate decisions come from {@link useAdminGate} (the single source of truth:
 * the moderation HEAD endpoint, with the documented dev bypass). This file owns
 * only the presentation of the four gate states (loading / signed-out / error /
 * denied) and the shared admin page chrome + sub-nav.
 */

import { Ban, Loader2, Shield } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useCloudT } from "../shell/CloudI18nProvider";
import { useAdminGate } from "./data/use-admin-gate";

/** Admin sub-navigation entries (in-app, role-gated business ops only). */
const ADMIN_NAV: ReadonlyArray<{
  path: string;
  labelKey: string;
  fallback: string;
}> = [
  {
    path: "/dashboard/admin",
    labelKey: "cloud.admin.nav.moderation",
    fallback: "Moderation",
  },
  {
    path: "/dashboard/admin/redemptions",
    labelKey: "cloud.admin.nav.redemptions",
    fallback: "Redemptions",
  },
  {
    path: "/dashboard/admin/rpc-status",
    labelKey: "cloud.admin.nav.rpcStatus",
    fallback: "RPC status",
  },
];

function GateState({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      {children}
    </div>
  );
}

/** Shared sub-nav rendered above every admin page once the gate passes. */
function AdminSubNav(): React.JSX.Element {
  const t = useCloudT();
  const location = useLocation();
  return (
    <nav className="flex flex-wrap gap-2 text-xs">
      {ADMIN_NAV.map((item) => {
        const active =
          item.path === "/dashboard/admin"
            ? location.pathname === item.path
            : location.pathname.startsWith(item.path);
        return (
          <Link
            key={item.path}
            to={item.path}
            className={
              active
                ? "rounded-sm bg-accent/15 px-3 py-1 text-accent"
                : "rounded-sm bg-white/5 px-3 py-1 text-white/70 hover:bg-white/10"
            }
          >
            {t(item.labelKey, { defaultValue: item.fallback })}
          </Link>
        );
      })}
    </nav>
  );
}

export interface AdminGateProps {
  children: ReactNode;
}

/**
 * Wrap an admin route body. Renders the gate states until the user is confirmed
 * admin, then renders the shared admin chrome (sub-nav) + the page body.
 */
export function AdminGate({ children }: AdminGateProps): React.JSX.Element {
  const t = useCloudT();
  const { isAdmin, isLoading, isError, isAuthenticated } = useAdminGate();

  if (isLoading) {
    return (
      <GateState>
        <Loader2 className="h-8 w-8 animate-spin text-accent" />
      </GateState>
    );
  }

  if (!isAuthenticated) {
    return (
      <GateState>
        <Shield className="h-16 w-16 text-muted-foreground" />
        <h1 className="text-2xl font-bold">
          {t("cloud.admin.gate.signInTitle", {
            defaultValue: "Sign in required",
          })}
        </h1>
        <p className="text-muted-foreground">
          {t("cloud.admin.gate.signInBody", {
            defaultValue: "Sign in to access the admin surfaces.",
          })}
        </p>
        <Link
          to="/login?returnTo=%2Fdashboard%2Fadmin"
          className="rounded-sm bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:bg-accent-hover"
        >
          {t("cloud.admin.gate.signInCta", { defaultValue: "Sign in" })}
        </Link>
      </GateState>
    );
  }

  if (isError) {
    return (
      <GateState>
        <Shield className="h-16 w-16 text-muted-foreground" />
        <h1 className="text-2xl font-bold">
          {t("cloud.admin.gate.unavailableTitle", {
            defaultValue: "Admin status unavailable",
          })}
        </h1>
        <p className="text-muted-foreground">
          {t("cloud.admin.gate.unavailableBody", {
            defaultValue: "Could not verify admin role.",
          })}
        </p>
      </GateState>
    );
  }

  if (!isAdmin) {
    return (
      <GateState>
        <Ban className="h-16 w-16 text-danger" />
        <h1 className="text-2xl font-bold">
          {t("cloud.admin.gate.deniedTitle", { defaultValue: "Access denied" })}
        </h1>
        <p className="text-muted-foreground">
          {t("cloud.admin.gate.deniedBody", {
            defaultValue: "You don't have admin privileges.",
          })}
        </p>
      </GateState>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <AdminSubNav />
      {children}
    </div>
  );
}
