/**
 * Shared account menu for authenticated Cloud management headers. The normal
 * managed app and deterministic preview both mount this component so account,
 * billing, and sign-out behavior cannot drift into separate interfaces.
 */

import { ChevronDown, LogOut, UserRound } from "lucide-react";
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
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
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const signOutPending = useRef(false);
  const accountLabel = t("cloud.nav.account", { defaultValue: "Account" });

  const signOut = async () => {
    if (signOutPending.current) return;
    signOutPending.current = true;
    setSigningOut(true);
    setSignOutError(null);
    try {
      if (onSignOut) {
        await onSignOut();
        return;
      }
      const { signOutFromSsoBridgedHost } = await import(
        "../sso-bridge/sso-bridge"
      );
      await signOutFromSsoBridgedHost();
      navigate("/login", { replace: true });
    } catch {
      // error-policy:J4 keep the authenticated route and a visible menu retry when teardown fails.
      setSignOutError(
        t("cloud.userMenu.signOutFailed", {
          defaultValue: "Could not sign out safely. Please try again.",
        }),
      );
      setOpen(true);
    } finally {
      signOutPending.current = false;
      setSigningOut(false);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        disabled={signingOut}
        aria-busy={signingOut || undefined}
        aria-label={email ? `Account menu for ${email}` : "Account menu"}
        className="keyboard-focus-surface flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-md px-2 text-sm text-txt transition-colors hover:bg-bg-hover"
      >
        <UserRound className="size-4 shrink-0" aria-hidden />
        <span className="hidden max-w-40 truncate md:inline">
          {email || accountLabel}
        </span>
        <ChevronDown
          className="hidden  size-3.5 shrink-0 md:block"
          aria-hidden
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {signOutError && (
          <p
            role="alert"
            className="max-w-64 px-2 py-2 text-sm text-destructive"
          >
            {signOutError}
          </p>
        )}
        <DropdownMenuItem onSelect={() => navigate("/cloud/account")}>
          {accountLabel}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate("/cloud/billing")}>
          {t("cloud.nav.billing", { defaultValue: "Billing" })}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive"
          disabled={signingOut}
          onSelect={() => void signOut()}
        >
          <LogOut className="mr-2 size-3.5" aria-hidden />
          {t("cloud.userMenu.signOut", { defaultValue: "Sign out" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default CloudAccountMenu;
