"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  PrivyProvider as PrivyProviderReactAuth,
  usePrivy,
  type PrivyClientConfig,
} from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";

// Define configuration outside component to prevent recreating on every render
const loginMethods: ("wallet" | "email" | "google" | "discord" | "github")[] = [
  "wallet",
  "email",
  "google",
  "discord",
  "github",
];

// Use a unique string key on globalThis to store connectors cache
// This survives HMR (Hot Module Replacement) and module re-evaluations
// which would otherwise cause WalletConnect to be initialized multiple times
const SOLANA_CONNECTORS_KEY = "__ELIZA_CLOUD_SOLANA_CONNECTORS__";

type SolanaConnectors = ReturnType<typeof toSolanaWalletConnectors>;

// Create Solana wallet connectors once globally to prevent
// WalletConnect double-initialization in React Strict Mode and during HMR
const getSolanaConnectors = (): SolanaConnectors => {
  const globalCache = globalThis as unknown as Record<
    string,
    SolanaConnectors | undefined
  >;

  if (globalCache[SOLANA_CONNECTORS_KEY]) {
    return globalCache[SOLANA_CONNECTORS_KEY];
  }

  const connectors = toSolanaWalletConnectors();
  globalCache[SOLANA_CONNECTORS_KEY] = connectors;
  return connectors;
};

/**
 * Wrapper component to handle post-authentication logic
 * Handles migration of anonymous user data after successful authentication
 */
function PrivyAuthWrapper({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, user, getAccessToken } = usePrivy();
  const migrationAttempted = useRef(false);

  useEffect(() => {
    // Call migration endpoint after successful authentication
    if (ready && authenticated && user && !migrationAttempted.current) {
      migrationAttempted.current = true;

      // Check for anonymous session token in localStorage
      // (httpOnly cookies can't be read via document.cookie, so we use localStorage as backup)
      let sessionToken = localStorage.getItem("eliza-anon-session-token");

      // Also check document.cookie as fallback (in case cookie was set without httpOnly in dev)
      const hasAnonCookie = document.cookie.includes("eliza-anon-session");

      // Also check URL for session token (in case localStorage was cleared)
      const urlParams = new URLSearchParams(window.location.search);
      const urlSessionToken = urlParams.get("session");
      if (urlSessionToken && !sessionToken) {
        sessionToken = urlSessionToken;
      }

      if (sessionToken || hasAnonCookie) {
        // Helper function to attempt migration with retry
        const attemptMigration = async (retryCount = 0): Promise<void> => {
          const maxRetries = 3;
          const retryDelay = 1000; // 1 second

          try {
            // Get fresh access token to ensure auth is ready
            const accessToken = await getAccessToken();

            const response = await fetch("/api/auth/migrate-anonymous", {
              method: "POST",
              credentials: "include",
              headers: {
                "Content-Type": "application/json",
                ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
              },
              body: JSON.stringify({ sessionToken: sessionToken || undefined }),
            });

            const data = await response.json();

            if (data.success && data.migrated) {
              cleanupAndNotify();
              reloadIfNeeded();
            } else if (data.error && retryCount < maxRetries) {
              setTimeout(() => attemptMigration(retryCount + 1), retryDelay);
            } else {
              cleanupAndNotify();
            }
          } catch (error) {
            if (retryCount < maxRetries) {
              setTimeout(() => attemptMigration(retryCount + 1), retryDelay);
            } else {
              cleanupAndNotify();
            }
          }
        };

        const cleanupAndNotify = () => {
          localStorage.removeItem("eliza-anon-session-token");
          window.dispatchEvent(new CustomEvent("anonymous-session-migrated"));
        };

        const reloadIfNeeded = () => {
          const currentPath = window.location.pathname;
          if (
            currentPath.startsWith("/chat/") ||
            currentPath.includes("/my-agents") ||
            currentPath.includes("/dashboard")
          ) {
            setTimeout(() => {
              window.location.reload();
            }, 500);
          }
        };

        // Small delay to ensure Privy auth cookies are set
        setTimeout(() => attemptMigration(), 500);
      }
    }
  }, [ready, authenticated, user, getAccessToken]);

  return children;
}

export default function PrivyProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // Memoize the config to prevent unnecessary re-renders (must be before early return)
  // PrivyClientConfig accepts partial configurations at runtime, but the type is strict.
  // We define the exact shape we're providing and cast to the expected interface.
  const privyConfig = useMemo(
    (): PrivyClientConfig => ({
      loginMethods,
      embeddedWallets: {
        ethereum: {
          createOnLogin: "users-without-wallets",
        },
        solana: {
          createOnLogin: "users-without-wallets",
        },
      },
      appearance: {
        walletChainType: "ethereum-and-solana",
        theme: "dark",
        accentColor: "#6366F1",
        walletList: [
          "metamask",
          "phantom",
          "coinbase_wallet",
          "rabby_wallet",
          "okx_wallet",
        ],
      },
      externalWallets: {
        solana: {
          // Use cached connectors to prevent WalletConnect double-init in Strict Mode
          connectors: getSolanaConnectors(),
        },
      },
    }),
    [],
  );

  // Check if Privy App ID is configured
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const clientId = process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID;

  if (!appId || !clientId) {
    console.error(
      "NEXT_PUBLIC_PRIVY_APP_ID or NEXT_PUBLIC_PRIVY_CLIENT_ID is not set!",
    );
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-red-600">
            Configuration Error
          </h1>
          <p className="mt-2">Privy configuration is missing.</p>
          <p className="text-sm text-gray-500 mt-1">
            Please set NEXT_PUBLIC_PRIVY_APP_ID and NEXT_PUBLIC_PRIVY_CLIENT_ID
            in your environment variables.
          </p>
        </div>
      </div>
    );
  }

  return (
    <PrivyProviderReactAuth
      appId={appId}
      clientId={clientId}
      config={privyConfig}
    >
      <PrivyAuthWrapper>{children}</PrivyAuthWrapper>
    </PrivyProviderReactAuth>
  );
}
