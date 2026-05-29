"use client";

import "./globals.css";

import { useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Toaster } from "sonner";
import { FeedAuthBanner } from "@/components/auth/FeedAuthBanner";
import { GlobalLoginModal } from "@/components/auth/GlobalLoginModal";
import { Providers } from "@/components/providers/Providers";
import { BottomNav } from "@/components/shared/BottomNav";
import { MobileHeader } from "@/components/shared/MobileHeader";
import { Sidebar } from "@/components/shared/Sidebar";
import { AppUrlListener } from "@/mobile/components/AppUrlListener";
import { initNativeFeatures, updateTheme } from "@/mobile/lib/native-init";

/**
 * Mobile root layout — client-only version.
 *
 * Differences from the web layout:
 * - No headers() / host detection (not relevant in native app)
 * - No waitlist host check
 * - No NftAccessGate server-side check
 * - No Vercel Analytics / SpeedInsights
 * - All rendering is client-side (required for static export)
 */
export default function MobileRootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  const router = useRouter();

  const navigate = useCallback((path: string) => router.push(path), [router]);

  useEffect(() => setMounted(true), []);

  // Initialize native Capacitor features once mounted
  useEffect(() => {
    if (!mounted) return;
    // Detect theme from the document (next-themes sets data-theme attribute)
    const theme =
      document.documentElement.classList.contains("dark") ||
      document.documentElement.getAttribute("data-theme") === "dark"
        ? "dark"
        : "light";
    initNativeFeatures({ theme, navigate });
  }, [mounted, navigate]);

  // Update status bar when theme changes
  useEffect(() => {
    if (!mounted) return;
    const observer = new MutationObserver(() => {
      const isDark =
        document.documentElement.classList.contains("dark") ||
        document.documentElement.getAttribute("data-theme") === "dark";
      updateTheme(isDark ? "dark" : "light");
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    return () => observer.disconnect();
  }, [mounted]);

  return (
    <html lang="en" suppressHydrationWarning className="overscroll-none">
      <head>
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
        />
      </head>
      <body
        className="overscroll-none bg-background font-sans antialiased"
        suppressHydrationWarning
      >
        <AppUrlListener />

        {mounted ? (
          <Providers>
            <Toaster position="top-center" richColors />
            <Suspense fallback={null}>
              <GlobalLoginModal />
            </Suspense>

            {/* Mobile Header */}
            <Suspense fallback={null}>
              <MobileHeader />
            </Suspense>

            <div className="mark mx-auto flex min-h-screen max-w-7xl bg-sidebar">
              {/* Desktop Sidebar */}
              <Suspense fallback={null}>
                <Sidebar />
              </Suspense>

              {/* Main Content Area */}
              <main className="min-h-screen min-w-0 flex-1 bg-background pb-14 md:pb-0">
                {children}
              </main>

              {/* Mobile Bottom Navigation */}
              <Suspense fallback={null}>
                <BottomNav />
              </Suspense>
            </div>

            {/* Auth Banner */}
            <Suspense fallback={null}>
              <FeedAuthBanner />
            </Suspense>
          </Providers>
        ) : (
          <div className="min-h-screen bg-sidebar" />
        )}
      </body>
    </html>
  );
}
