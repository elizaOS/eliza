import type { Metadata, Viewport } from "next";
import "./globals.css";

import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Suspense } from "react";
import { Toaster } from "sonner";
import { GlobalLoginModal } from "@/components/auth/GlobalLoginModal";
import { Providers } from "@/components/providers/Providers";
import { BottomNav } from "@/components/shared/BottomNav";
import { MobileHeader } from "@/components/shared/MobileHeader";
import { Sidebar } from "@/components/shared/Sidebar";

export const metadata: Metadata = {
  title: "Polyagent",
  description:
    "Create and manage autonomous AI agents that trade on Polymarket prediction markets.",
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL || "https://polyagent.app",
  ),
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    shortcut: "/favicon.svg",
    apple: "/favicon.svg",
  },
  openGraph: {
    title: "Polyagent",
    description:
      "Create and manage autonomous AI agents that trade on Polymarket prediction markets.",
    url: process.env.NEXT_PUBLIC_APP_URL || "https://polyagent.app",
    siteName: "Polyagent",
    images: [
      {
        url: "/assets/images/og-image.png",
        width: 1200,
        height: 630,
        alt: "Polyagent - Autonomous Polymarket Trading Agents",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Polyagent",
    description:
      "Create and manage autonomous AI agents that trade on Polymarket prediction markets.",
    images: ["/assets/images/og-image.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "white" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning className="overscroll-none">
      <body
        className="overscroll-none bg-background font-sans antialiased"
        suppressHydrationWarning
      >
        <Providers>
          <Toaster position="top-center" richColors />
          <Suspense fallback={null}>
            <GlobalLoginModal />
          </Suspense>

          {/* Mobile Header */}
          <Suspense fallback={null}>
            <MobileHeader />
          </Suspense>

          <div className="flex min-h-screen w-full bg-sidebar">
            {/* Desktop Sidebar */}
            <Suspense fallback={null}>
              <Sidebar />
            </Suspense>

            {/* Main Content Area */}
            <main className="min-h-screen min-w-0 flex-1 bg-background pt-14 pb-14 md:pt-0 md:pb-0">
              {children}
            </main>

            {/* Mobile Bottom Navigation */}
            <Suspense fallback={null}>
              <BottomNav />
            </Suspense>
          </div>
        </Providers>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
