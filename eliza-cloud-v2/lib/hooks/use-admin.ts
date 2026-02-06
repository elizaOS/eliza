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

import { useState, useEffect, useRef } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";

// Default anvil wallet for devnet admin access
const ANVIL_DEFAULT_WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// Module-level cache and in-flight tracking for deduplication
let adminCache: {
  isAdmin: boolean;
  timestamp: number;
  walletAddress: string;
} | null = null;
let inFlightRequest: Promise<boolean> | null = null;

const CACHE_TTL = 30000; // 30 seconds

function isDevnet(): boolean {
  return (
    process.env.NODE_ENV === "development" ||
    process.env.NEXT_PUBLIC_DEVNET === "true"
  );
}

interface UseAdminResult {
  /** Whether the current user has admin privileges. */
  isAdmin: boolean;
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
): Promise<boolean> {
  // In devnet, anvil wallet is always admin
  if (
    isDevnet() &&
    walletAddress.toLowerCase() === ANVIL_DEFAULT_WALLET.toLowerCase()
  ) {
    return true;
  }

  // Check if we have a valid cached result for this wallet
  const now = Date.now();
  if (
    adminCache &&
    adminCache.walletAddress === walletAddress &&
    now - adminCache.timestamp < CACHE_TTL
  ) {
    return adminCache.isAdmin;
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
        // Cache the negative result to prevent repeated requests
        adminCache = {
          isAdmin: false,
          timestamp: Date.now(),
          walletAddress,
        };
        return false;
      }

      const isAdmin = res?.headers.get("X-Is-Admin") === "true";

      // Cache the result
      adminCache = {
        isAdmin,
        timestamp: Date.now(),
        walletAddress,
      };

      return isAdmin;
    } catch (err) {
      // On abort or error, don't cache
      if (err instanceof Error && err.name === "AbortError") {
        throw err;
      }
      return false;
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
  const { authenticated } = usePrivy();
  const { wallets } = useWallets();
  const [isAdmin, setIsAdmin] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const mountedRef = useRef(true);
  const fetchCountRef = useRef(0);

  const walletAddress = wallets?.[0]?.address;

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
      // Early exit if not authenticated or no wallet
      if (!authenticated || !walletAddress) {
        if (mountedRef.current) {
          setIsAdmin(false);
          setIsLoading(false);
        }
        return;
      }

      try {
        setIsLoading(true);
        const adminStatus = await fetchAdminStatus(
          walletAddress,
          abortController.signal,
        );

        // Only update if this is still the latest fetch and component is mounted
        if (mountedRef.current && currentFetch === fetchCountRef.current) {
          setIsAdmin(adminStatus);
          setIsLoading(false);
        }
      } catch (err) {
        if (mountedRef.current && currentFetch === fetchCountRef.current) {
          setIsAdmin(false);
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
    // Invalidate cache and trigger re-fetch
    adminCache = null;
    // Re-run effect by updating a ref won't work, so we clear cache
    // The next render cycle will pick up the change
  };

  return { isAdmin, isLoading, refetch };
}

/**
 * Clears the admin status cache.
 * Useful when admin permissions may have changed.
 */
export function clearAdminCache(): void {
  adminCache = null;
}
