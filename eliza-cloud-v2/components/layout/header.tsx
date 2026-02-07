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

import { memo, useCallback, useState } from "react";
import { Menu, LogIn, Plus } from "lucide-react";
import { useRouter, usePathname } from "next/navigation";
import { BrandButton } from "@/components/brand";
import UserMenu from "./user-menu";
import { usePageHeader } from "./page-header-context";
import { QuickCreateDialog } from "@/components/builders";

interface HeaderProps {
  onToggleSidebar: () => void;
  children?: React.ReactNode;
  isAnonymous?: boolean;
}

function HeaderComponent({
  onToggleSidebar,
  children,
  isAnonymous = false,
}: HeaderProps) {
  const { pageInfo } = usePageHeader();
  const router = useRouter();
  const pathname = usePathname();
  const [showQuickCreate, setShowQuickCreate] = useState(false);

  // Redirect to login page with returnTo to preserve current location (including query params like characterId)
  const handleLogin = useCallback(() => {
    const fullUrl =
      pathname + (typeof window !== "undefined" ? window.location.search : "");
    router.push(`/login?returnTo=${encodeURIComponent(fullUrl)}`);
  }, [router, pathname]);

  return (
    <header className="flex h-14 md:h-16 items-center justify-between bg-black rounded-2xl px-3 md:px-6">
      <div className="flex items-center gap-3 md:gap-4 flex-1 min-w-0">
        {/* Mobile Menu Button */}
        <BrandButton
          variant="ghost"
          size="icon"
          className="md:hidden shrink-0 size-8"
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
      <div className="flex items-center gap-3 md:gap-4 shrink-0">
        {pageInfo?.actions && <div>{pageInfo.actions}</div>}
        {children}

        {/* Show signup button for anonymous users, otherwise user menu */}
        {isAnonymous ? (
          <BrandButton
            variant="primary"
            onClick={handleLogin}
            className="gap-2 h-8 px-3 md:h-10 md:px-4"
          >
            <LogIn className="h-4 w-4" />
            <span className="hidden md:inline">Sign Up Free</span>
            <span className="md:hidden">Sign Up</span>
          </BrandButton>
        ) : (
          <div className="flex flex-row items-center gap-3 md:gap-4">
            <BrandButton
              variant="primary"
              onClick={() => setShowQuickCreate(true)}
              className="gap-2 items-center h-8 px-3 md:h-10 md:px-4"
            >
              <Plus className="size-4" />
              <span className="hidden md:inline">Create</span>
            </BrandButton>
            <UserMenu />
          </div>
        )}
      </div>

      <QuickCreateDialog
        open={showQuickCreate}
        onOpenChange={setShowQuickCreate}
      />
    </header>
  );
}

// Memoize the header to prevent re-renders when parent state changes
const Header = memo(HeaderComponent);
export default Header;
