"use client";

import { BrandButton, DashboardHeader, usePageHeader } from "@elizaos/ui";
import { LanguageDropdown } from "@elizaos/ui/components/shared/LanguageDropdown";
import { LogIn } from "lucide-react";
import { memo, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useI18n } from "@/providers/I18nProvider";
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
  const { lang, setLang, t } = useI18n();

  return (
    <DashboardHeader
      onToggleSidebar={onToggleSidebar}
      pageInfo={pageInfo}
      isAnonymous={isAnonymous}
      loginHref={loginUrl}
      anonymousCta={
        <Link to={loginUrl}>
          <BrandButton
            variant="primary"
            className="h-8 gap-2 px-3 md:h-10 md:px-4"
          >
            <LogIn className="h-4 w-4" />
            <span className="hidden md:inline">
              {t("cloud.header.signUpFree", { defaultValue: "Sign Up Free" })}
            </span>
            <span className="md:hidden">
              {t("cloud.header.signUp", { defaultValue: "Sign Up" })}
            </span>
          </BrandButton>
        </Link>
      }
      rightContent={
        <div className="flex min-w-0 flex-row items-center gap-2 md:gap-4">
          <LanguageDropdown
            uiLanguage={lang}
            setUiLanguage={setLang}
            variant="titlebar"
          />
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
