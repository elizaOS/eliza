"use client";

import { LogIn, Menu } from "lucide-react";
import { memo, type ReactNode } from "react";
import { BrandButton } from "../brand";

export interface DashboardHeaderPageInfo {
  title: string;
  actions?: ReactNode;
}

export interface DashboardHeaderProps {
  onToggleSidebar: () => void;
  pageInfo?: DashboardHeaderPageInfo | null;
  isAnonymous?: boolean;
  loginHref?: string;
  anonymousCta?: ReactNode;
  rightContent?: ReactNode;
  children?: ReactNode;
}

function DashboardHeaderComponent({
  onToggleSidebar,
  pageInfo,
  isAnonymous = false,
  loginHref = "/login",
  anonymousCta,
  rightContent,
  children,
}: DashboardHeaderProps) {
  const defaultAnonymousCta = (
    <a href={loginHref}>
      <BrandButton variant="primary" className="h-8 gap-2 px-3 md:h-10 md:px-4">
        <LogIn className="h-4 w-4" />
        <span className="hidden md:inline">Sign Up Free</span>
        <span className="md:hidden">Sign Up</span>
      </BrandButton>
    </a>
  );

  return (
    <header className="flex min-h-14 items-center justify-between gap-2 border-b border-white/14 bg-black px-3 py-2 md:min-h-16 md:gap-4 md:px-6">
      <div className="flex min-w-0 flex-1 items-center gap-3 md:gap-4">
        <BrandButton
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 border border-white/14 bg-transparent md:hidden"
          onClick={onToggleSidebar}
          aria-label="Toggle navigation"
        >
          <Menu className="h-4 w-4 text-white" />
        </BrandButton>

        {pageInfo && (
          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="truncate text-base font-semibold tracking-tight text-white md:text-lg">
              {pageInfo.title}
            </h1>
          </div>
        )}
      </div>

      <div className="flex min-w-0 shrink-0 items-center justify-end gap-2 md:gap-4">
        {pageInfo?.actions && (
          <div className="flex min-w-0 max-w-[46vw] items-center justify-end overflow-x-auto sm:max-w-none">
            {pageInfo.actions}
          </div>
        )}
        {children}
        {isAnonymous ? (anonymousCta ?? defaultAnonymousCta) : rightContent}
      </div>
    </header>
  );
}

export const DashboardHeader = memo(DashboardHeaderComponent);
