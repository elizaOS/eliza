"use client";

import { useEffect, useRef, Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import {
  initPostHog,
  identifyUser,
  resetUser,
  trackEvent,
  getPostHog,
  getSignupMethod,
  type PrivyUserAuthInfo,
} from "@/lib/analytics/posthog";

function PageViewTracker(): null {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    const posthog = getPostHog();
    if (!posthog) return;

    const queryString = searchParams?.toString();
    const url = queryString ? `${pathname}?${queryString}` : pathname;

    posthog.capture("$pageview", {
      $current_url: url,
      page_path: pathname,
    });
  }, [pathname, searchParams]);

  return null;
}

function UserIdentifier(): null {
  const { ready, authenticated, user } = usePrivy();
  const identifiedRef = useRef(false);
  const previousAuthState = useRef<boolean | null>(null);

  useEffect(() => {
    // AbortController cancels in-flight requests on cleanup (logout/unmount)
    const abortController = new AbortController();

    if (!ready) return;

    // Handle logout
    if (previousAuthState.current === true && !authenticated) {
      resetUser();
      identifiedRef.current = false;
      trackEvent("logout_completed");
    }

    // Handle login - fetch internal user ID for consistent identification
    if (authenticated && user && !identifiedRef.current) {
      const authInfo: PrivyUserAuthInfo = {
        email: user.email ? { address: user.email.address ?? undefined } : null,
        google: user.google
          ? {
              email: user.google.email ?? undefined,
              name: user.google.name ?? undefined,
            }
          : null,
        discord: user.discord
          ? {
              email: user.discord.email ?? undefined,
              username: user.discord.username ?? undefined,
            }
          : null,
        github: user.github
          ? { username: user.github.username ?? undefined }
          : null,
        wallet: user.wallet ? { address: user.wallet.address ?? undefined } : null,
      };
      const email =
        authInfo.email?.address ??
        authInfo.google?.email ??
        authInfo.discord?.email;
      const name =
        authInfo.google?.name ??
        authInfo.discord?.username ??
        authInfo.github?.username;
      const method = getSignupMethod(authInfo);
      const isFirstLogin = previousAuthState.current === false;

      // Fetch internal user ID from API
      fetch("/api/v1/user", { signal: abortController.signal })
        .then((res) => res.json())
        .then((data) => {
          // identifiedRef prevents duplicate identification
          // AbortController prevents this callback from running after logout
          if (!identifiedRef.current && data.success && data.data?.id) {
            identifyUser(data.data.id, {
              email,
              name,
              wallet_address: user.wallet?.address,
              signup_method: method,
              created_at: user.createdAt?.toISOString(),
            });

            identifiedRef.current = true;

            if (isFirstLogin) {
              trackEvent("login_completed", { method });
            }
          }
        })
        .catch((error) => {
          // Ignore abort errors - expected when component unmounts or user logs out
          if (error instanceof Error && error.name === "AbortError") return;
          console.error("[PostHog] Failed to fetch user ID:", error);
        });
    }

    previousAuthState.current = authenticated;

    // Cleanup: abort any in-flight fetch when effect re-runs or component unmounts
    return () => {
      abortController.abort();
    };
  }, [ready, authenticated, user]);

  return null;
}

interface PostHogProviderProps {
  children: React.ReactNode;
}

export function PostHogProvider({
  children,
}: PostHogProviderProps): React.ReactElement {
  useEffect(() => {
    initPostHog();
  }, []);

  return (
    <>
      <Suspense fallback={null}>
        <PageViewTracker />
      </Suspense>
      <UserIdentifier />
      {children}
    </>
  );
}

export default PostHogProvider;
