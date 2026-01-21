"use client";

import { logger, privyConfig } from "@polyagent/shared";
import { type PrivyClientConfig, PrivyProvider } from "@privy-io/react-auth";
import { SmartWalletsProvider } from "@privy-io/react-auth/smart-wallets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Fragment, Suspense, useEffect, useRef, useState } from "react";
import { PostHogErrorBoundary } from "@/components/analytics/PostHogErrorBoundary";
import { PostHogIdentifier } from "@/components/analytics/PostHogIdentifier";
import { ThemeProvider } from "@/components/shared/ThemeProvider";
import { FontSizeProvider } from "@/contexts/FontSizeContext";
import { WidgetRefreshProvider } from "@/contexts/WidgetRefreshContext";
import { PostHogProvider } from "./PostHogProvider";

/**
 * Wrapper component to fix clip-path DOM property issue in Privy.
 *
 * Fixes the React 19 warning about invalid DOM property 'clip-path'.
 * Privy uses 'clip-path' in inline styles, which React 19 rejects.
 * This wrapper converts 'clip-path' to 'clipPath' (camelCase) after render.
 */
function PrivyProviderWrapper({
  children,
  appId,
  ...props
}: React.ComponentProps<typeof PrivyProvider>) {
  if (!appId || appId.trim() === "") {
    return <>{children}</>;
  }

  const privyProps = { ...props } as Omit<
    React.ComponentProps<typeof PrivyProvider>,
    "appId" | "children"
  >;

  if ("isActive" in privyProps) {
    logger.warn(
      'Invalid prop "isActive" passed to PrivyProviderWrapper - this prop is not supported by PrivyProvider',
      undefined,
      "PrivyProviderWrapper",
    );
    delete (privyProps as Record<string, unknown>).isActive;
  }

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fixClipPath = () => {
      if (!containerRef.current) return;

      const allElements = containerRef.current.querySelectorAll("*");
      allElements.forEach((element) => {
        const htmlElement = element as HTMLElement;
        const styleAttr = htmlElement.getAttribute("style");
        if (styleAttr?.includes("clip-path")) {
          const clipPathMatch = styleAttr.match(/clip-path\s*:\s*([^;]+)/);
          if (clipPathMatch?.[1]) {
            const clipPathValue = clipPathMatch[1].trim();
            (
              htmlElement.style as CSSStyleDeclaration & { clipPath?: string }
            ).clipPath = clipPathValue;
            const cleanedStyle = styleAttr
              .replace(/clip-path\s*:\s*[^;]+;?/g, "")
              .trim()
              .replace(/;\s*;/g, ";")
              .replace(/^;|;$/g, "");

            if (cleanedStyle) {
              htmlElement.setAttribute("style", cleanedStyle);
            } else {
              htmlElement.removeAttribute("style");
            }
          }
        }

        const computedStyle = htmlElement.style as CSSStyleDeclaration &
          Record<string, string | undefined>;
        if (
          computedStyle &&
          "clip-path" in computedStyle &&
          !computedStyle.clipPath
        ) {
          const clipPathValue = (
            computedStyle as Record<string, string | undefined>
          )["clip-path"];
          if (clipPathValue) {
            computedStyle.clipPath = clipPathValue;
            delete (computedStyle as Record<string, string | undefined>)[
              "clip-path"
            ];
          }
        }
      });
    };

    const runFix = () => {
      requestAnimationFrame(() => {
        fixClipPath();
        setTimeout(fixClipPath, 50);
      });
    };

    const timeoutId = setTimeout(runFix, 100);

    const observer = new MutationObserver(() => {
      requestAnimationFrame(fixClipPath);
    });

    if (containerRef.current) {
      observer.observe(containerRef.current, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style"],
      });
    }

    return () => {
      clearTimeout(timeoutId);
      observer.disconnect();
    };
  }, []);

  const trimmedAppId = appId.trim();

  return (
    <div ref={containerRef}>
      <PrivyProvider appId={trimmedAppId} {...privyProps}>
        {children}
      </PrivyProvider>
    </div>
  );
}

/**
 * Root providers component for the Polymarket Agent Manager.
 *
 * Provides:
 * - Privy authentication with smart wallets
 * - React Query for data fetching
 * - Theme management
 * - PostHog analytics
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);

  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  const hasPrivyConfig = privyConfig.appId && privyConfig.appId !== "";

  useEffect(() => {
    setMounted(true);
  }, []);

  // Render without Privy if not configured
  if (!hasPrivyConfig) {
    if (mounted && typeof window !== "undefined") {
      logger.warn(
        "Privy not configured: NEXT_PUBLIC_PRIVY_APP_ID was not set at build time. " +
          "Authentication features will be disabled.",
        undefined,
        "Providers",
      );
    }

    return (
      <div suppressHydrationWarning>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange={false}
        >
          <FontSizeProvider>
            <QueryClientProvider client={queryClient}>
              <WidgetRefreshProvider>
                {mounted ? (
                  <Fragment>
                    <div
                      data-testid="privy-not-configured-warning"
                      className="fixed top-0 right-0 left-0 z-[9999] bg-yellow-500 py-1 text-center font-medium text-black text-sm"
                    >
                      ⚠️ Privy authentication not configured -
                      NEXT_PUBLIC_PRIVY_APP_ID missing at build time
                    </div>
                    {children}
                  </Fragment>
                ) : (
                  <div className="min-h-screen bg-sidebar" />
                )}
              </WidgetRefreshProvider>
            </QueryClientProvider>
          </FontSizeProvider>
        </ThemeProvider>
      </div>
    );
  }

  return (
    <div suppressHydrationWarning>
      <PostHogErrorBoundary>
        <Suspense fallback={null}>
          <PostHogProvider>
            <ThemeProvider
              attribute="class"
              defaultTheme="system"
              enableSystem
              disableTransitionOnChange={false}
            >
              <FontSizeProvider>
                <QueryClientProvider client={queryClient}>
                  <PrivyProviderWrapper
                    appId={privyConfig.appId}
                    config={privyConfig.config as PrivyClientConfig}
                  >
                    <SmartWalletsProvider>
                      <PostHogIdentifier />
                      <WidgetRefreshProvider>
                        {mounted ? (
                          children
                        ) : (
                          <div className="min-h-screen bg-sidebar" />
                        )}
                      </WidgetRefreshProvider>
                    </SmartWalletsProvider>
                  </PrivyProviderWrapper>
                </QueryClientProvider>
              </FontSizeProvider>
            </ThemeProvider>
          </PostHogProvider>
        </Suspense>
      </PostHogErrorBoundary>
    </div>
  );
}
