/**
 * User menu dropdown component displaying authentication state and user actions.
 * Shows user avatar, credit balance, and navigation options (settings, API keys, logout).
 * Handles logout and chat data clearing.
 *
 * Wrapped in an error boundary to prevent crashes from propagating to the page.
 */

"use client";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@elizaos/cloud-ui";
import {
  BookOpen,
  Coins,
  Key,
  Loader2,
  LogOut,
  MessageSquare,
  SettingsIcon,
  UserCircle,
} from "lucide-react";
import { Component, type ErrorInfo, type ReactNode, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  type StewardSessionUser,
  useSessionAuth,
  useStewardAuth,
} from "@/lib/hooks/use-session-auth";
import { useCredits } from "@/lib/providers/CreditsProvider";
import { useChatStore } from "@/lib/stores/chat-store";
import { FeedbackModal } from "./feedback-modal";

interface UserProfileResponse {
  success?: boolean;
  data?: {
    id?: string;
    name?: string | null;
    avatar?: string | null;
    email?: string | null;
    organization?: { credit_balance?: string | number | null } | null;
  } | null;
}

function isUserProfileResponse(value: unknown): value is UserProfileResponse {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface UserProfile {
  id: string;
  name: string | null;
  avatar: string | null;
  email: string | null;
  organizationCreditBalance?: number | null;
}

// ---------------------------------------------------------------------------
// Error Boundary – catches render errors so the whole page doesn't crash
// ---------------------------------------------------------------------------
interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

class UserMenuErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[UserMenu] Render error caught by boundary:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          // Fallback: direct link to account page in case dropdown fails
          <Link
            to="/dashboard/account"
            className="flex items-center justify-center h-8 w-8 md:h-10 md:w-10 border border-white/10 bg-white/5 hover:border-orange-500/50 hover:bg-white/10 transition-colors opacity-80"
            title="Account Settings"
          >
            <UserCircle className="h-5 w-5 text-white" />
          </Link>
        )
      );
    }
    return this.props.children;
  }
}

function sessionWallet(user: StewardSessionUser): string | null {
  const w = user?.walletAddress;
  return typeof w === "string" && w.length > 0 ? w : null;
}

function sessionEmail(user: StewardSessionUser): string | null {
  const e = user?.email;
  return typeof e === "string" && e.length > 0 ? e : null;
}

function sessionDisplayName(user: StewardSessionUser): string {
  const email = sessionEmail(user);
  if (email) {
    const prefix = email.split("@")[0];
    if (prefix) return prefix;
  }
  const wallet = sessionWallet(user);
  if (wallet && wallet.length >= 10) {
    return `${wallet.substring(0, 6)}...${wallet.substring(wallet.length - 4)}`;
  }
  return "User";
}

function sessionIdentifier(user: StewardSessionUser): string {
  const wallet = sessionWallet(user);
  if (wallet && wallet.length >= 14) {
    return `${wallet.substring(0, 8)}...${wallet.substring(wallet.length - 6)}`;
  }
  const email = sessionEmail(user);
  if (email) return email;
  return "Connected";
}

function sessionInitials(profile: UserProfile | null, user: StewardSessionUser): string {
  const name = profile?.name || sessionDisplayName(user);
  if (name && name !== "User" && name.trim().length > 0) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length > 0 && parts[0].length > 0) {
      return parts
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);
    }
  }
  const email = profile?.email || sessionEmail(user);
  if (email && email.length >= 2) {
    return email.slice(0, 2).toUpperCase();
  }
  return "U";
}

// ---------------------------------------------------------------------------
// Safe credit balance formatter
// ---------------------------------------------------------------------------
function formatCreditBalance(balance: number | null): string {
  try {
    if (balance === null || balance === undefined) return "0.00";
    const num = Number(balance);
    if (Number.isNaN(num) || !Number.isFinite(num)) return "0.00";
    return num.toFixed(2);
  } catch {
    return "0.00";
  }
}

interface UserMenuProps {
  preserveWhileUnauthed?: boolean;
}

// ---------------------------------------------------------------------------
// Main component (inner)
// ---------------------------------------------------------------------------
function UserMenuInner({ preserveWhileUnauthed = false }: UserMenuProps) {
  const {
    ready,
    authenticated,
    stewardAuthenticated,
    stewardUser,
    user: currentUser,
  } = useSessionAuth();
  const { signOut: stewardSignOut } = useStewardAuth();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const { creditBalance, isLoading: loadingCredits } = useCredits();
  const { clearChatData } = useChatStore();

  // User profile state for avatar
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [lastAuthenticatedUser, setLastAuthenticatedUser] = useState<StewardSessionUser>(null);

  useEffect(() => {
    if (authenticated && currentUser) {
      setLastAuthenticatedUser(currentUser);
      return;
    }

    if (!preserveWhileUnauthed) {
      setLastAuthenticatedUser(null);
      setUserProfile(null);
    }
  }, [authenticated, currentUser, preserveWhileUnauthed]);

  const effectiveUser = authenticated
    ? currentUser
    : preserveWhileUnauthed
      ? lastAuthenticatedUser
      : null;

  // Fetch user profile from API to get avatar and org balance
  useEffect(() => {
    if (!authenticated) return;

    let mounted = true;

    const fetchProfile = async () => {
      try {
        const response = await fetch("/api/v1/user");
        if (response.ok && mounted) {
          const data = await response.json();
          if (isUserProfileResponse(data) && data.success && data.data) {
            const profile = data.data;
            setUserProfile({
              id: profile.id ?? "",
              name: profile.name ?? null,
              avatar: profile.avatar ?? null,
              email: profile.email ?? null,
              organizationCreditBalance:
                profile.organization?.credit_balance !== undefined
                  ? Number(profile.organization.credit_balance)
                  : null,
            });
          }
        }
      } catch (error) {
        console.error("[UserMenu] Failed to fetch user profile:", error);
      }
    };

    fetchProfile();

    // Listen for avatar updates and post-migration refreshes.
    const handleProfileRefresh = () => {
      void fetchProfile();
    };
    window.addEventListener("user-avatar-updated", handleProfileRefresh);
    window.addEventListener("anon-migration-complete", handleProfileRefresh);
    window.addEventListener("steward-token-sync", handleProfileRefresh);

    return () => {
      mounted = false;
      window.removeEventListener("user-avatar-updated", handleProfileRefresh);
      window.removeEventListener("anon-migration-complete", handleProfileRefresh);
      window.removeEventListener("steward-token-sync", handleProfileRefresh);
    };
  }, [authenticated]);

  // Loading state
  if (!ready && !effectiveUser) {
    return (
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  // Build login URL with returnTo parameter to return to current page after login
  const loginUrl = (() => {
    const fullUrl = `${pathname}${search}`;
    return `/login?returnTo=${encodeURIComponent(fullUrl)}`;
  })();

  // Signed out state — use plain <a> tags to avoid dependency on client-side router
  // which can break when RSC navigation has issues
  if (!effectiveUser) {
    return (
      <div className="flex items-center gap-2">
        <Link to={loginUrl}>
          <Button variant="ghost" size="sm" disabled={!ready}>
            Log in
          </Button>
        </Link>
        <Link to={loginUrl}>
          <Button size="sm" disabled={!ready}>
            Sign Up
          </Button>
        </Link>
      </div>
    );
  }

  // Handle sign out
  const onSignOut = async () => {
    try {
      // Clear chat data (rooms, entityId, localStorage)
      clearChatData();

      if (stewardAuthenticated) {
        stewardSignOut();
        await fetch("/api/auth/steward-session", { method: "DELETE" }).catch(() => {});
      }
      await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});

      // Use replace to avoid browser history pollution
      // This prevents back button issues after re-login
      navigate("/", { replace: true });
    } catch (error) {
      console.error("[UserMenu] Error during sign out:", error);
      // Still try to redirect even if logout partially fails
      navigate("/", { replace: true });
    }
  };

  // Pre-compute all display values safely, preferring server profile for Steward sessions
  const displayName =
    userProfile?.name ||
    userProfile?.email?.split("@")[0] ||
    (stewardAuthenticated && stewardUser?.email
      ? stewardUser.email.split("@")[0]
      : sessionDisplayName(effectiveUser));
  const displayIdentifier =
    userProfile?.email ||
    (stewardAuthenticated && stewardUser?.email ? stewardUser.email : null) ||
    sessionIdentifier(effectiveUser);
  const initials = (() => {
    if (userProfile?.name || userProfile?.email) {
      const source = userProfile.name || userProfile.email || "U";
      const parts = source.trim().split(/\s+/).filter(Boolean);
      if (parts.length > 1)
        return parts
          .map((n) => n[0])
          .join("")
          .toUpperCase()
          .slice(0, 2);
      return source.slice(0, 2).toUpperCase();
    }
    if (stewardAuthenticated && stewardUser?.email) {
      return stewardUser.email.slice(0, 2).toUpperCase();
    }
    return sessionInitials(userProfile, effectiveUser);
  })();
  const feedbackName = userProfile?.name || displayName;
  const feedbackEmail =
    userProfile?.email ||
    (stewardAuthenticated && stewardUser?.email ? stewardUser.email : "") ||
    sessionEmail(effectiveUser) ||
    "";

  // Signed in state
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="relative h-8 w-8 border-white/10 bg-white/5 p-0 hover:border-[#FF5800]/50 hover:bg-white/10 md:h-10 md:w-10"
          >
            <Avatar className="h-8 w-8 md:h-10 md:w-10 rounded-none">
              {userProfile?.avatar && (
                <AvatarImage
                  src={userProfile.avatar}
                  alt={userProfile.name || "User avatar"}
                  className="object-cover"
                />
              )}
              <AvatarFallback className="rounded-none bg-gradient-to-br from-[#FF5800]/20 to-[#FF5800]/5 font-semibold text-white">
                {initials}
              </AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        {/* Keep the menu lazily mounted. Eager mounting (`forceMount`) can trip the
            error boundary during transient auth/provider churn even while the menu is closed. */}
        <DropdownMenuContent className="w-56" align="end">
          <DropdownMenuLabel className="font-normal">
            <div className="flex min-w-0 flex-col space-y-1">
              <p className="truncate text-sm font-medium leading-none" title={displayName}>
                {displayName}
              </p>
              <p
                className="truncate text-xs leading-none text-muted-foreground"
                title={displayIdentifier}
              >
                {displayIdentifier}
              </p>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <div className="px-2 py-2">
            {loadingCredits &&
            creditBalance === null &&
            userProfile?.organizationCreditBalance == null ? (
              <div className="flex items-center gap-2 border border-white/10 bg-white/5 px-2 py-1.5">
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Loading...</span>
              </div>
            ) : (
              <Link to="/dashboard/settings?tab=billing" className="block">
                <Badge
                  variant="secondary"
                  className="gap-1.5 px-3 py-1.5 w-full justify-center cursor-pointer hover:bg-white/10"
                >
                  <Coins className="h-3.5 w-3.5 select-none" />
                  <span className="font-semibold select-none">
                    $
                    {formatCreditBalance(
                      creditBalance ?? userProfile?.organizationCreditBalance ?? null,
                    )}
                  </span>
                  <span className="text-xs opacity-80 select-none">balance</span>
                </Badge>
              </Link>
            )}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link to="/dashboard/account">
              <UserCircle className="mr-2 h-4 w-4" />
              <span>Account</span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/dashboard/settings">
              <SettingsIcon className="mr-2 h-4 w-4" />
              <span>Settings</span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/dashboard/settings?tab=billing">
              <Coins className="mr-2 h-4 w-4" />
              <span>Billing</span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/dashboard/api-keys">
              <Key className="mr-2 h-4 w-4" />
              <span>API Keys</span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/docs">
              <BookOpen className="mr-2 h-4 w-4" />
              <span>Docs</span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setFeedbackOpen(true)}>
            <MessageSquare className="mr-2 h-4 w-4" />
            <span>Feedback</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="bg-red-500/40 data-[highlighted]:bg-red-500/60 data-[highlighted]:text-white"
            onClick={onSignOut}
          >
            <LogOut className="mr-2 h-4 w-4" />
            <span>Sign out</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <FeedbackModal
        open={feedbackOpen}
        onOpenChange={setFeedbackOpen}
        defaultName={feedbackName}
        defaultEmail={feedbackEmail}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Exported component – wrapped in error boundary
// ---------------------------------------------------------------------------
export default function UserMenu({ preserveWhileUnauthed = false }: UserMenuProps) {
  return (
    <UserMenuErrorBoundary>
      <UserMenuInner preserveWhileUnauthed={preserveWhileUnauthed} />
    </UserMenuErrorBoundary>
  );
}
