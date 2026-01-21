"use client";

import { cn } from "@polyagent/shared";
import { Wallet } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";

/**
 * Login button component for wallet connection.
 *
 * Displays a "Connect Wallet" button that triggers the authentication
 * flow when clicked. Automatically disables when auth is not ready.
 * Uses Privy for wallet connection.
 *
 * @returns Login button element
 *
 * @example
 * ```tsx
 * <LoginButton />
 * ```
 */
export function LoginButton() {
  const { ready, login } = useAuth();

  return (
    <button
      onClick={login}
      disabled={!ready}
      className={cn(
        "flex w-full items-center justify-center gap-2 rounded-full px-4 py-2.5 font-semibold",
        "bg-sidebar-primary text-sidebar-primary-foreground",
        "hover:bg-sidebar-primary/90",
        "transition-colors duration-200",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "text-[15px] leading-5",
      )}
    >
      <Wallet className="h-5 w-5" />
      <span>Connect Wallet</span>
    </button>
  );
}
