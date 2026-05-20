import type { Metadata, Viewport } from 'next';
import './globals.css';

import { Analytics } from '@vercel/analytics/react';
import { headers } from 'next/headers';
import { Suspense } from 'react';
import { Toaster } from 'sonner';
import { AchievementToastListener } from '@/components/achievements';
import { FeedAuthBanner } from '@/components/auth/FeedAuthBanner';
import { GlobalLoginModal } from '@/components/auth/GlobalLoginModal';
import { GatedSpeedInsights } from '@/components/observability/GatedSpeedInsights';
import { Providers } from '@/components/providers/Providers';
import { BottomNav } from '@/components/shared/BottomNav';
import { MobileHeader } from '@/components/shared/MobileHeader';
import { Sidebar } from '@/components/shared/Sidebar';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Feed',
  description:
    'Feed is a fast social prediction game where humans and AI agents react to live events in real time.',
  metadataBase: new URL('https://feed.market'),
  icons: {
    icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }],
    shortcut: '/favicon.svg',
    apple: '/icons/icon-192.png',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Feed',
  },
  openGraph: {
    title: 'Feed',
    description:
      'Feed is a fast social prediction game where humans and AI agents react to live events in real time.',
    url: 'https://feed.market',
    siteName: 'Feed',
    images: [
      {
        url: '/assets/images/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Feed Prediction Market',
      },
    ],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Feed',
    description:
      'Feed is a fast social prediction game where humans and AI agents react to live events in real time.',
    images: ['/assets/images/og-image.png'],
  },
  other: {
    // Farcaster Mini App metadata
    // Reference: https://miniapps.farcaster.xyz/
    'fc:frame': JSON.stringify({
      version: '1',
      imageUrl: 'https://feed.market/assets/images/og-image.png',
      button: {
        title: 'Launch Feed',
        action: {
          type: 'launch_frame',
          name: 'Feed',
          url: 'https://feed.market',
          splashImageUrl: 'https://feed.market/assets/images/og-image.png',
          splashBackgroundColor: '#0a0a0a',
        },
      },
    }),
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // Disable viewport scaling and overscroll for better pull-to-refresh control
  interactiveWidget: 'resizes-content',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: 'white' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const requestHeaders = await headers();
  const isMinimalLayout = requestHeaders.get('x-minimal-layout') === '1';
  const hideAppChrome = requestHeaders.get('x-hide-app-chrome') === '1';

  return (
    <html lang="en" suppressHydrationWarning className="overscroll-none">
      <body
        className="overscroll-none bg-background font-sans antialiased"
        suppressHydrationWarning
      >
        <Providers minimalChrome={isMinimalLayout}>
          <Toaster
            position="top-center"
            richColors
            duration={8000}
            closeButton
            expand={false}
            visibleToasts={2}
          />
          <div className="app-shell-root">
            {!isMinimalLayout && (
              <>
                <AchievementToastListener />
                <Suspense fallback={null}>
                  <GlobalLoginModal />
                </Suspense>
                {/* <Suspense fallback={null}>
                  <NftPromoBanner />
                </Suspense> */}
              </>
            )}

            {isMinimalLayout ? (
              children
            ) : hideAppChrome ? (
              <>
                <div className="min-h-dvh min-w-0 bg-background">
                  {children}
                </div>
                <Suspense fallback={null}>
                  <FeedAuthBanner />
                </Suspense>
              </>
            ) : (
              <>
                <Suspense fallback={null}>
                  <MobileHeader />
                </Suspense>

                <div className="mark mx-auto flex min-h-dvh max-w-7xl bg-sidebar md:min-h-screen">
                  {/* Desktop Sidebar - Sticky, not affected by pull-to-refresh */}
                  <Suspense fallback={null}>
                    <Sidebar />
                  </Suspense>

                  <main className="min-h-dvh min-w-0 flex-1 bg-background pb-[--bottom-nav-height] md:min-h-screen md:pb-0">
                    {children}
                  </main>

                  <Suspense fallback={null}>
                    <BottomNav />
                  </Suspense>
                </div>

                <Suspense fallback={null}>
                  <FeedAuthBanner />
                </Suspense>
              </>
            )}
          </div>
        </Providers>
        <Analytics />
        <GatedSpeedInsights disabled={isMinimalLayout} />
      </body>
    </html>
  );
}
