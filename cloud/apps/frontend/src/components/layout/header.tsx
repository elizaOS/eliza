/**
 * Application header component with navigation and user menu.
 * Memoized to prevent unnecessary re-renders from parent state changes.
 *
 * @param props - Header configuration
 * @param props.onToggleSidebar - Callback to toggle mobile sidebar visibility
 * @param props.children - Additional content to render in header
 * @param props.isAnonymous - Whether user is anonymous (shows sign up button instead of user menu)
 */

"use client";

import { LogIn, Menu } from "lucide-react";
import { memo, useState } from "react";
import { useLocation } from "react-router-dom";
import { BrandButton } from "@elizaos/cloud-ui";
import { HeaderInviteButton } from "./header-invite-button";
import { usePageHeader } from "@elizaos/cloud-ui";
import UserMenu from "./user-menu";

interface HeaderProps {
  onToggleSidebar: () => void;
  children?: React.ReactNode;
  isAnonymous?: boolean;
  authGraceActive?: boolean;
}

function HeaderComponent({
  onToggleSidebar,
  children,
  isAnonymous = false,
  authGraceActive = false,
}: HeaderProps) {
  const { pageInfo } = usePageHeader();
  const pathname = useLocation().pathname;
  const [_showQuickCreate, _setShowQuickCreate] = useState(false);

  // Build login URL with returnTo to preserve current location (including query params like characterId)
  const loginUrl = (() => {
    const fullUrl = pathname + (typeof window !== "undefined" ? window.location.search : "");
    return `/login?returnTo=${encodeURIComponent(fullUrl)}`;
  })();

  return (
    <header className="flex min-h-14 items-center justify-between gap-2 border border-white/10 bg-black/70 px-3 py-2 md:min-h-16 md:gap-4 md:px-6">
      <div className="flex min-w-0 flex-1 items-center gap-3 md:gap-4">
        {/* Mobile Menu Button */}
        <BrandButton
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 border-white/10 bg-white/5 md:hidden"
          onClick={onToggleSidebar}
          aria-label="Toggle navigation"
        >
          <Menu className="h-4 w-4 text-white" />
        </BrandButton>

        {/* Page Title and Description */}
        {pageInfo && (
          <div className="flex flex-col min-w-0 flex-1">
            <h1 className="text-base md:text-lg font-semibold tracking-tight truncate text-white">
              {pageInfo.title}
            </h1>
          </div>
        )}
      </div>

      {/* Right side content */}
      <div className="flex min-w-0 shrink-0 items-center justify-end gap-2 md:gap-4">
        {pageInfo?.actions && (
          <div className="flex min-w-0 max-w-[46vw] items-center justify-end overflow-x-auto sm:max-w-none">
            {pageInfo.actions}
          </div>
        )}
        {children}

        {/* Show signup button for anonymous users, otherwise user menu */}
        {isAnonymous ? (
          <a href={loginUrl}>
            <BrandButton variant="primary" className="gap-2 h-8 px-3 md:h-10 md:px-4">
              <LogIn className="h-4 w-4" />
              <span className="hidden md:inline">Sign Up Free</span>
              <span className="md:hidden">Sign Up</span>
            </BrandButton>
          </a>
        ) : (
          <div className="flex min-w-0 flex-row items-center gap-2 md:gap-4">
            {/* WHY hide Invite during authGraceActive: Session may not be ready; fetch would 401 and confuse users next to UserMenu preserveWhileUnauthed. */}
            {!authGraceActive ? <HeaderInviteButton /> : null}
            <UserMenu preserveWhileUnauthed={authGraceActive} />
          </div>
        )}
      </div>
    </header>
  );
}

// Memoize the header to prevent re-renders when parent state changes
const Header = memo(HeaderComponent);
export default Header;
