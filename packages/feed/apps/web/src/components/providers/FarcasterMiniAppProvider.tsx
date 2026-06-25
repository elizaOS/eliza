"use client";

import { sdk } from "@farcaster/miniapp-sdk";
import { logger } from "@feed/shared";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useStewardAuthContext } from "./StewardAuthProvider";

/**
 * Farcaster Mini App Provider.
 *
 * Phase 2: Auto-authenticates via the Feed /api/auth/farcaster-miniapp
 * endpoint (quickAuth JWKS verification) instead of legacy auth.
 *
 * Flow:
 * 1. Detect mini-app context via sdk.context
 * 2. Call sdk.quickAuth.getToken() to get a Farcaster-signed JWT
 * 3. POST the token to /api/auth/farcaster-miniapp to get a Steward-compatible JWT
 * 4. Call onLoginSuccess() to set the httpOnly cookie and fetch user profile
 */

interface MiniAppContext {
  user?: { fid: number; username: string };
}

interface FarcasterMiniAppContextType {
  isMiniApp: boolean;
  isLoading: boolean;
  error?: string;
  fid?: number;
  username?: string;
  context: MiniAppContext | null;
  share: (options: {
    text?: string;
    url?: string;
    embeds?: string[];
  }) => Promise<void>;
}

const FarcasterMiniAppContext =
  createContext<FarcasterMiniAppContextType | null>(null);

export function useFarcasterMiniApp() {
  const context = useContext(FarcasterMiniAppContext);
  if (!context)
    throw new Error(
      "useFarcasterMiniApp must be used within FarcasterMiniAppProvider",
    );
  return context;
}

export function FarcasterMiniAppProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { onLoginSuccess } = useStewardAuthContext();
  const [isMiniApp, setIsMiniApp] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [fid, setFid] = useState<number>();
  const [username, setUsername] = useState<string>();
  const [miniAppContext, setMiniAppContext] = useState<MiniAppContext | null>(
    null,
  );
  const hasCalledReady = useRef(false);
  const hasAttemptedLogin = useRef(false);
  const isAuthenticated = useRef(false);

  // Detect mini-app context and initialize SDK
  useEffect(() => {
    if (typeof window === "undefined") return;

    const initializeMiniApp = async () => {
      const context = await sdk.context;

      if (context) {
        setIsMiniApp(true);
        setMiniAppContext(context as MiniAppContext);

        if (context.user) {
          setFid(context.user.fid);
          setUsername(context.user.username);
        }

        logger.info(
          "Detected Farcaster Mini App context",
          { fid: context.user?.fid, username: context.user?.username },
          "FarcasterMiniApp",
        );

        if (!hasCalledReady.current) {
          hasCalledReady.current = true;
          setTimeout(async () => {
            await sdk.actions.ready();
            logger.info(
              "Farcaster Mini App ready() called",
              {},
              "FarcasterMiniApp",
            );
          }, 100);
        }
      }
      setIsLoading(false);
    };

    void initializeMiniApp();
  }, []);

  // Auto-login via quickAuth when mini-app is detected and user is not yet authenticated
  useEffect(() => {
    if (
      !isMiniApp ||
      isLoading ||
      isAuthenticated.current ||
      hasAttemptedLogin.current
    )
      return;
    hasAttemptedLogin.current = true;

    const attemptLogin = async () => {
      logger.info(
        "Attempting Farcaster quickAuth auto-login",
        { fid, username },
        "FarcasterMiniApp",
      );

      // quickAuth.getToken() returns a Farcaster-signed JWT containing the FID
      const quickAuthResult = await (
        sdk as {
          quickAuth: { getToken(): Promise<{ token: string }> };
        }
      ).quickAuth.getToken();
      const quickAuthToken = quickAuthResult.token;

      const res = await fetch("/api/auth/farcaster-miniapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token: quickAuthToken }),
      });

      const data = (await res.json()) as {
        ok: boolean;
        token?: string;
        error?: string;
      };
      if (!data.ok || !data.token) {
        throw new Error(data.error ?? "Farcaster miniapp auth failed");
      }

      // Set httpOnly cookie and trigger profile fetch
      await onLoginSuccess(data.token);
      isAuthenticated.current = true;

      logger.info(
        "Farcaster Mini App quickAuth login successful",
        { fid, username },
        "FarcasterMiniApp",
      );
    };

    attemptLogin().catch((err: Error) => {
      hasAttemptedLogin.current = false;
      logger.error(
        "Farcaster Mini App quickAuth failed",
        { error: err.message, fid },
        "FarcasterMiniApp",
      );
      setError(err.message);
    });
  }, [isMiniApp, isLoading, fid, username, onLoginSuccess]);

  const share = async (options: {
    text?: string;
    url?: string;
    embeds?: string[];
  }) => {
    if (!isMiniApp) {
      logger.warn(
        "Attempted to use Mini App share outside of Mini App context",
        {},
        "FarcasterMiniApp",
      );
      return;
    }
    await sdk.actions.openUrl(
      `https://farcaster.xyz/~/compose?text=${encodeURIComponent(options.text ?? "")}${
        options.url ? `&embeds[]=${encodeURIComponent(options.url)}` : ""
      }`,
    );
    logger.info("Mini App share opened", options, "FarcasterMiniApp");
  };

  return (
    <FarcasterMiniAppContext.Provider
      value={{
        isMiniApp,
        isLoading,
        error,
        fid,
        username,
        context: miniAppContext,
        share,
      }}
    >
      {children}
    </FarcasterMiniAppContext.Provider>
  );
}
