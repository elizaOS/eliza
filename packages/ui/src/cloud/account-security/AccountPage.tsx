/**
 * Standalone Account console page mounted by the cloud router shell at
 * `dashboard/account` — profile/identity management on the apex console
 * (elizacloud.ai), where the in-app Settings view never mounts. Thin wrapper
 * around the self-loading {@link AccountSurface} (the same body the
 * `cloud-account` Settings section renders in the app).
 *
 * Default export for `React.lazy` code-splitting from the route registration.
 */

import { Lock } from "lucide-react";
import { Link } from "react-router-dom";
import { useCloudT } from "../shell/CloudI18nProvider";
import { AccountSurface } from "./AccountSurface";

export function AccountPage() {
  const t = useCloudT();
  // No local PageHeaderProvider: the surface's useSetPageHeader must reach
  // ConsoleShell's provider or the top bar shows no title (a local provider
  // is a dead context nothing reads). Document title is set by AccountSurface.
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6 md:py-8">
      <AccountSurface />
      {/* Security lost its sidebar slot in the launch nav cut; keep it one
          click away from the account it belongs to. */}
      <Link
        to="/dashboard/security"
        className="mt-6 flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-4 transition-colors hover:border-accent/40 hover:bg-surface"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent/12 text-accent">
          <Lock className="h-[18px] w-[18px]" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium leading-5 text-txt-strong">
            {t("cloud.account.securityLink", {
              defaultValue: "Sessions & security",
            })}
          </span>
          <span className="text-xs leading-relaxed text-muted">
            {t("cloud.account.securityLinkDesc", {
              defaultValue: "Active sessions, privacy, and audit log.",
            })}
          </span>
        </span>
      </Link>
    </div>
  );
}

export default AccountPage;
