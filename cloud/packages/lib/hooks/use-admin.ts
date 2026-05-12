/**
 * Admin status hook with request deduplication.
 *
 * Prevents multiple sidebar sections from making duplicate admin check requests
 * by using a module-level cache and in-flight request tracking.
 *
 * @example
 * ```ts
 * const { isAdmin, isLoading } = useAdmin();
 * if (isAdmin) {
 *   // Show admin UI
 * }
 * ```
 */

"use client";

import { useEffect, useRef, useState } from "react";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";

// Default anvil wallet for devnet admin access
const ANVIL_DEFAULT_WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

type AdminRole = "super_admin" | "moderator" | "viewer";

// Module-level cache and in-flight tracking for deduplication
let adminCache: {
  isAdmin: boolean;
  role: AdminRole | null;
  timestamp: number;
  walletAddress: string;
} | null = null;
let inFlightRequest: Promise<{
  isAdmin: boolean;
  role: AdminRole | null;
}> | null = null;

const CACHE_TTL = 30000; // 30 seconds

function isDevnet(): boolean {
  return process.env.NODE_ENV === "development" || process.env.NEXT_PUBLIC_DEVNET === "true";
}

interface UseAdminResult {
  /** Whether the current user has admin privileges. */
  isAdmin: boolean;
  /** The admin role (super_admin, moderator, viewer) or null. */
  adminRole: AdminRole | null;
  /** Whether the admin check is in progress. */
  isLoading: boolean;
  /** Force a recheck of admin status. */
  refetch: () => void;
}

/**
 * Fetches admin status with deduplication.
 * Multiple concurrent calls will share the same in-flight request.
 */
async function fetchAdminStatus(
  walletAddress: string,
  signal: AbortSignal,
): Promise<{ isAdmin: boolean; role: AdminRole | null }> {
  // In devnet, anvil wallet is always admin
  if (isDevnet() && walletAddress.toLowerCase() === ANVIL_DEFAULT_WALLET.toLowerCase()) {
    return { isAdmin: true, role: "super_admin" };
  }

  // Check if we have a valid cached result for this wallet
  const now = Date.now();
  if (
    adminCache &&
    adminCache.walletAddress === walletAddress &&
    now - adminCache.timestamp < CACHE_TTL
  ) {
    return { isAdmin: adminCache.isAdmin, role: adminCache.role };
  }

  // If there's already an in-flight request, join it
  if (inFlightRequest) {
    return inFlightRequest;
  }

  // Start new request
  inFlightRequest = (async () => {
    try {
      const res = await fetch("/api/v1/admin/moderation", {
        method: "HEAD",
        signal,
      });

      // Handle non-200 responses gracefully - treat as not admin
      if (!res.ok) {
        adminCache = {
          isAdmin: false,
          role: null,
          timestamp: Date.now(),
          walletAddress,
        };
        return { isAdmin: false, role: null } as const;
      }

      const isAdmin = res?.headers.get("X-Is-Admin") === "true";
      const roleHeader = res?.headers.get("X-Admin-Role");
      const role =
        roleHeader && ["super_admin", "moderator", "viewer"].includes(roleHeader)
          ? (roleHeader as AdminRole)
          : null;

      adminCache = {
        isAdmin,
        role,
        timestamp: Date.now(),
        walletAddress,
      };

      return { isAdmin, role };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw err;
      }
      return { isAdmin: false, role: null } as const;
    } finally {
      inFlightRequest = null;
    }
  })();

  return inFlightRequest;
}

/**
 * Hook to check if the current user has admin privileges.
 * Deduplicates concurrent requests across multiple component instances.
 */
export function useAdmin(): UseAdminResult {
  const { authenticated, user } = useSessionAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminRole, setAdminRole] = useState<AdminRole | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [_refetchCounter, setRefetchCounter] = useState(0);
  const mountedRef = useRef(true);
  const fetchCountRef = useRef(0);

  // TODO(steward): external wallet-connect (MetaMask / Phantom / WalletConnect)
  // is a Steward gap; admin checks currently rely on the wallet that the user
  // signed-in-with-Steward already linked. Once Steward exposes connected
  // wallets via the SDK, prefer those here.
  const walletAddress =
    user && "walletAddress" in user && typeof user.walletAddress === "string"
      ? user.walletAddress
      : undefined;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const abortController = new AbortController();
    const currentFetch = ++fetchCountRef.current;

    const checkAdmin = async () => {
      if (!authenticated || !walletAddress) {
        if (mountedRef.current) {
          setIsAdmin(false);
          setAdminRole(null);
          setIsLoading(false);
        }
        return;
      }

      try {
        setIsLoading(true);
        const status = await fetchAdminStatus(walletAddress, abortController.signal);

        if (mountedRef.current && currentFetch === fetchCountRef.current) {
          setIsAdmin(status.isAdmin);
          setAdminRole(status.role);
          setIsLoading(false);
        }
      } catch (_err) {
        if (mountedRef.current && currentFetch === fetchCountRef.current) {
          setIsAdmin(false);
          setAdminRole(null);
          setIsLoading(false);
        }
      }
    };

    checkAdmin();

    return () => {
      abortController.abort();
    };
  }, [authenticated, walletAddress]);

  const refetch = () => {
    adminCache = null;
    setRefetchCounter((c) => c + 1);
  };

  return { isAdmin, adminRole, isLoading, refetch };
}

/**
 * Clears the admin status cache.
 * Useful when admin permissions may have changed.
 */
export function clearAdminCache(): void {
  adminCache = null;
}
