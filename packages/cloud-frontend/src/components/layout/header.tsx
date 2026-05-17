"use client";

import { DashboardHeader, usePageHeader } from "@elizaos/ui";
import { memo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { HeaderInviteButton } from "./header-invite-button";
import UserMenu from "./user-menu";

interface HeaderProps {
  onToggleSidebar: () => void;
  children?: ReactNode;
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
  const fullUrl =
    pathname + (typeof window !== "undefined" ? window.location.search : "");
  const loginUrl = `/login?returnTo=${encodeURIComponent(fullUrl)}`;

  return (
    <DashboardHeader
      onToggleSidebar={onToggleSidebar}
      pageInfo={pageInfo}
      isAnonymous={isAnonymous}
      loginHref={loginUrl}
      rightContent={
        <div className="flex min-w-0 flex-row items-center gap-2 md:gap-4">
          {!authGraceActive ? <HeaderInviteButton /> : null}
          <UserMenu preserveWhileUnauthed={authGraceActive} />
        </div>
      }
    >
      {children}
    </DashboardHeader>
  );
}

const Header = memo(HeaderComponent);
export default Header;
