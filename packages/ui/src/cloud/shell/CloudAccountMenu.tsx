/**
 * Shared account menu for authenticated Cloud management headers. The normal
 * managed app and deterministic preview both mount this component so account,
 * billing, and sign-out behavior cannot drift into separate interfaces.
 */

import { ChevronDown, LogOut, UserRound } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { useCloudT } from "./CloudI18nProvider";

export interface CloudAccountMenuProps {
  email: string | null;
  /** Local fixtures can inject their isolated teardown without touching a
   * real Steward session. Production omits this and uses the canonical clear. */
  onSignOut?: () => void;
}

export function CloudAccountMenu({
  email,
  onSignOut,
}: CloudAccountMenuProps): React.JSX.Element {
  const navigate = useNavigate();
  const t = useCloudT();
  const accountLabel = t("cloud.nav.account", { defaultValue: "Account" });

  const signOut = async () => {
    if (onSignOut) {
      await onSignOut();
      return;
    }
    try {
      const { signOutFromSsoBridgedHost } = await import(
        "../sso-bridge/sso-bridge"
      );
      await signOutFromSsoBridgedHost();
      navigate("/login", { replace: true });
    } catch {
      // error-policy:J4 a failed canonical teardown stays on the authenticated
      // surface and gives the user a retry instead of claiming sign-out.
      toast.error(
        t("cloud.userMenu.signOutFailed", {
          defaultValue: "Could not sign out safely. Please try again.",
        }),
      );
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={email ? `Account menu for ${email}` : "Account menu"}
        className="keyboard-focus-surface flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-md px-2 text-sm text-txt transition-colors hover:bg-bg-hover"
      >
        <UserRound className="h-4 w-4 shrink-0" aria-hidden />
        <span className="hidden max-w-40 truncate md:inline">
          {email || accountLabel}
        </span>
        <ChevronDown
          className="hidden h-3.5 w-3.5 shrink-0 md:block"
          aria-hidden
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem onSelect={() => navigate("/cloud/account")}>
          {accountLabel}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate("/cloud/billing")}>
          {t("cloud.nav.billing", { defaultValue: "Billing" })}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-red-400"
          onSelect={() => void signOut()}
        >
          <LogOut className="mr-2 h-3.5 w-3.5" aria-hidden />
          {t("cloud.userMenu.signOut", { defaultValue: "Sign out" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default CloudAccountMenu;
