/**
 * User menu dropdown component displaying authentication state and user actions.
 * Shows user avatar, credit balance, and navigation options (settings, API keys, logout).
 * Handles logout and chat data clearing.
 */

"use client";

import { useState, useEffect } from "react";
import { usePrivy, useLogout } from "@privy-io/react-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  LogOut,
  Loader2,
  Coins,
  UserCircle,
  SettingsIcon,
  Key,
  BookOpen,
  MessageSquare,
} from "lucide-react";
import { useRouter, usePathname } from "next/navigation";
import { useCredits } from "@/lib/providers/CreditsProvider";
import { useChatStore } from "@/lib/stores/chat-store";
import { FeedbackModal } from "./feedback-modal";

interface UserProfile {
  id: string;
  name: string | null;
  avatar: string | null;
  email: string | null;
}

export default function UserMenu() {
  const { ready, authenticated, user } = usePrivy();
  const pathname = usePathname();
  const { logout } = useLogout();
  const router = useRouter();
  const { creditBalance, isLoading: loadingCredits } = useCredits();
  const { clearChatData } = useChatStore();

  // User profile state for avatar
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  // Fetch user profile from API to get avatar
  useEffect(() => {
    if (!authenticated) return;

    let mounted = true;

    const fetchProfile = async () => {
      try {
        const response = await fetch("/api/v1/user");
        if (response.ok && mounted) {
          const data = await response.json();
          if (data.success && data.data) {
            setUserProfile({
              id: data.data.id,
              name: data.data.name,
              avatar: data.data.avatar,
              email: data.data.email,
            });
          }
        }
      } catch (error) {
        console.error("Failed to fetch user profile:", error);
      }
    };

    fetchProfile();

    // Listen for avatar updates (when user saves a new avatar in settings)
    const handleAvatarUpdate = () => {
      fetchProfile();
    };
    window.addEventListener("user-avatar-updated", handleAvatarUpdate);

    return () => {
      mounted = false;
      window.removeEventListener("user-avatar-updated", handleAvatarUpdate);
    };
  }, [authenticated]);

  // Loading state
  if (!ready) {
    return (
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  // Handle login - redirect to custom login page with returnTo parameter
  // Include query params (like characterId) to return to exact page after login
  const handleLogin = () => {
    const fullUrl =
      pathname + (typeof window !== "undefined" ? window.location.search : "");
    router.push(`/login?returnTo=${encodeURIComponent(fullUrl)}`);
  };

  // Signed out state
  if (!authenticated || !user) {
    return (
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleLogin}
          disabled={!ready}
        >
          Log in
        </Button>
        <Button size="sm" onClick={handleLogin} disabled={!ready}>
          Sign Up
        </Button>
      </div>
    );
  }

  // Handle sign out
  const onSignOut = async () => {
    // Clear chat data (rooms, entityId, localStorage)
    clearChatData();

    // Call Privy's logout to clear authentication state
    await logout();

    // Use router.replace to avoid browser history pollution
    // This prevents back button issues after re-login
    router.replace("/");
  };

  // Get user details
  const getUserWallet = () => {
    // Check linked accounts for wallet
    if (user?.linkedAccounts) {
      for (const account of user.linkedAccounts) {
        // Type guard: check if account is a wallet
        if (
          account.type === "wallet" &&
          "address" in account &&
          typeof account.address === "string"
        ) {
          return account.address;
        }
      }
    }
    return null;
  };

  const getUserEmail = () => {
    if (user?.email?.address) {
      return user.email.address;
    }
    // Check linked accounts for email
    if (user?.linkedAccounts) {
      for (const account of user.linkedAccounts) {
        // Type guard: check if account has email property
        if ("address" in account && account.type === "email") {
          return account.address;
        }
        if ("email" in account && typeof account.email === "string") {
          return account.email;
        }
      }
    }
    return null;
  };

  const getUserName = () => {
    // Try to get name from various sources
    if (user?.google?.name) {
      return user.google.name;
    }
    if (user?.github?.username) {
      return user.github.username;
    }
    if (user?.linkedAccounts) {
      for (const account of user.linkedAccounts) {
        // Type guard: check if account has name property
        if ("name" in account && typeof account.name === "string") {
          return account.name;
        }
        // Type guard: check if account has username property
        if ("username" in account && typeof account.username === "string") {
          return account.username;
        }
      }
    }
    // Fall back to email or wallet
    const email = getUserEmail();
    if (email) {
      return email.split("@")[0];
    }
    const wallet = getUserWallet();
    if (wallet) {
      return `${wallet.substring(0, 6)}...${wallet.substring(wallet.length - 4)}`;
    }
    return "User";
  };

  const getUserIdentifier = () => {
    // Show wallet (preferred) or email
    const wallet = getUserWallet();
    if (wallet) {
      return `${wallet.substring(0, 8)}...${wallet.substring(wallet.length - 6)}`;
    }
    const email = getUserEmail();
    if (email) {
      return email;
    }
    return "No identifier";
  };

  // Get user initials for fallback
  const getInitials = () => {
    const name = userProfile?.name || getUserName();
    if (name && name !== "User") {
      return name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);
    }
    const email = userProfile?.email || getUserEmail();
    if (email) {
      return email.slice(0, 2).toUpperCase();
    }
    return "U";
  };

  // Signed in state
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="relative h-8 w-8 md:h-10 md:w-10 rounded-full ring-2 ring-transparent hover:ring-[#FF5800]/50 transition-all"
          >
            <Avatar className="h-8 w-8 md:h-10 md:w-10">
              {userProfile?.avatar && (
                <AvatarImage
                  src={userProfile.avatar}
                  alt={userProfile.name || "User avatar"}
                  className="object-cover"
                />
              )}
              <AvatarFallback className="bg-gradient-to-br from-[#FF5800]/20 to-[#FF5800]/5 text-white font-semibold">
                {getInitials()}
              </AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56" align="end" forceMount>
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col space-y-1">
              <p className="text-sm font-medium leading-none">
                {getUserName()}
              </p>
              <p className="text-xs leading-none text-muted-foreground">
                {getUserIdentifier()}
              </p>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <div className="px-2 py-2">
            {loadingCredits && creditBalance === null ? (
              <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-muted">
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                <span className="text-xs text-muted-foreground">
                  Loading...
                </span>
              </div>
            ) : (
              <Badge
                variant="secondary"
                className="gap-1.5 px-3 py-1.5 w-full justify-center cursor-pointer hover:bg-white/10"
                onClick={() => router.push("/dashboard/settings?tab=billing")}
              >
                <Coins className="h-3.5 w-3.5 select-none" />
                <span className="font-semibold select-none">
                  $
                  {creditBalance !== null
                    ? Number(creditBalance).toFixed(2)
                    : "0.00"}
                </span>
                <span className="text-xs opacity-80 select-none">balance</span>
              </Badge>
            )}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => router.push("/dashboard/account")}>
            <UserCircle className="mr-2 h-4 w-4" />
            <span>Account</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push("/dashboard/settings")}>
            <SettingsIcon className="mr-2 h-4 w-4" />
            <span>Settings</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => router.push("/dashboard/settings?tab=billing")}
          >
            <Coins className="mr-2 h-4 w-4" />
            <span>Billing</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push("/dashboard/api-keys")}>
            <Key className="mr-2 h-4 w-4" />
            <span>API Keys</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push("/docs")}>
            <BookOpen className="mr-2 h-4 w-4" />
            <span>Docs</span>
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
        defaultName={userProfile?.name || getUserName()}
        defaultEmail={userProfile?.email || getUserEmail() || ""}
      />
    </>
  );
}
