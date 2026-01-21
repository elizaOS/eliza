import { useCallback, useEffect, useState } from "react";
import { getAuthToken } from "@/lib/auth";
import { useAuthStore } from "@/stores/authStore";

/**
 * Represents the current Twitter authentication status.
 */
interface TwitterAuthStatus {
  /** Whether Twitter is currently connected */
  connected: boolean;
  /** Twitter screen name/username */
  screenName?: string;
  /** When the connection was established */
  connectedAt?: Date;
}

/**
 * Return type for the useTwitterAuth hook.
 */
interface UseTwitterAuthReturn {
  /** Current Twitter auth status, or null if not checked yet */
  authStatus: TwitterAuthStatus | null;
  /** Whether auth status is currently loading */
  loading: boolean;
  /** Any error that occurred */
  error: string | null;
  /** Function to initiate Twitter OAuth connection */
  connectTwitter: (returnPath?: string) => void;
  /** Function to disconnect Twitter account */
  disconnectTwitter: () => Promise<void>;
  /** Function to manually refresh auth status */
  refreshStatus: () => Promise<void>;
}

/**
 * Hook for managing Twitter OAuth authentication for posting posts.
 *
 * Provides functionality to connect and disconnect Twitter accounts via
 * OAuth 2.0. Automatically checks auth status on mount and when the user
 * changes. Handles OAuth callback redirects automatically.
 *
 * @returns Twitter authentication state and control functions.
 *
 * @example
 * ```tsx
 * const { authStatus, connectTwitter, disconnectTwitter } = useTwitterAuth();
 *
 * if (!authStatus?.connected) {
 *   return <button onClick={() => connectTwitter()}>Connect Twitter</button>;
 * }
 *
 * return (
 *   <div>
 *     Connected as @{authStatus.screenName}
 *     <button onClick={disconnectTwitter}>Disconnect</button>
 *   </div>
 * );
 * ```
 */
export function useTwitterAuth(): UseTwitterAuthReturn {
  const { user } = useAuthStore();
  const [authStatus, setAuthStatus] = useState<TwitterAuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const checkAuthStatus = useCallback(async () => {
    if (!user?.id) {
      setAuthStatus(null);
      setLoading(false);
      return;
    }

    const token = getAuthToken();
    if (!token) {
      setLoading(false);
      return;
    }

    const response = await fetch("/api/twitter/auth-status", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.ok) {
      const data = (await response.json()) as TwitterAuthStatus;
      setAuthStatus(data);
      setError(null);
    } else {
      setAuthStatus(null);
    }

    setLoading(false);
  }, [user?.id]);

  // Check auth status on mount and when user changes
  useEffect(() => {
    checkAuthStatus();
  }, [checkAuthStatus]);

  // Check for successful auth callback
  useEffect(() => {
    if (typeof window === "undefined") return;

    const urlParams = new URLSearchParams(window.location.search);
    const twitterAuth = urlParams.get("twitter_auth");

    if (twitterAuth === "success") {
      // Refresh auth status
      checkAuthStatus();

      // Clean up URL
      const url = new URL(window.location.href);
      url.searchParams.delete("twitter_auth");
      window.history.replaceState({}, "", url.toString());
    }
  }, [checkAuthStatus]);

  const connectTwitter = useCallback(
    (_returnPath?: string) => {
      if (!user?.id) {
        setError("Please sign in first");
        return;
      }

      // Redirect to OAuth 2.0 flow
      window.location.href = "/api/auth/twitter/initiate";
    },
    [user?.id],
  );

  const disconnectTwitter = useCallback(async () => {
    if (!user?.id) return;

    const token = getAuthToken();
    if (!token) return;

    const response = await fetch("/api/twitter/disconnect", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.ok) {
      setAuthStatus(null);
      setError(null);
    }
  }, [user?.id]);

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    await checkAuthStatus();
  }, [checkAuthStatus]);

  return {
    authStatus,
    loading,
    error,
    connectTwitter,
    disconnectTwitter,
    refreshStatus,
  };
}
