'use client';

import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from '@tanstack/react-query';
import { Fragment, Suspense, useEffect, useRef, useState } from 'react';
import { PostHogErrorBoundary } from '@/components/analytics/PostHogErrorBoundary';
import { PostHogIdentifier } from '@/components/analytics/PostHogIdentifier';
import { DevThemeToggle } from '@/components/shared/DevThemeToggle';
import { ThemeProvider } from '@/components/shared/ThemeProvider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { EmbedModeProvider } from '@/contexts/EmbedContext';
import { FontSizeProvider } from '@/contexts/FontSizeContext';
import { WidgetRefreshProvider } from '@/contexts/WidgetRefreshContext';
import { AutoDailyRewardProvider } from '@/hooks/useAutoDailyReward';
import { SessionHeartbeatProvider } from '@/hooks/useSessionHeartbeat';
import { getBrowserDevAuthSession } from '@/lib/auth/dev-auth';
import { hydrateChatCacheFromIndexedDB } from '@/lib/chat/hydrateChatCache';
import { useAuthStore } from '@/stores/authStore';
import { DiscordActivityProvider } from './DiscordActivityProvider';
import { FarcasterMiniAppProvider } from './FarcasterMiniAppProvider';
import { GameGuideProvider } from './GameGuideProvider';
import { GamePlaybackManager } from './GamePlaybackManager';
import { OnboardingProvider } from './OnboardingProvider';
import { OutcomeNotificationProvider } from './OutcomeNotificationProvider';
import { PostHogProvider } from './PostHogProvider';
import { ReferralCaptureProvider } from './ReferralCaptureProvider';
import { StewardAuthProvider } from './StewardAuthProvider';
import { TelegramMiniAppProvider } from './TelegramMiniAppProvider';

/**
 * Hydrates the React Query chat cache from IndexedDB once the authenticated
 * user is known. Renders nothing — purely a side-effect component.
 */
function ChatCacheHydrator() {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const hydratedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (user?.id && hydratedForRef.current !== user.id) {
      hydratedForRef.current = user.id;
      void hydrateChatCacheFromIndexedDB(queryClient, user.id);
    }
  }, [user?.id, queryClient]);

  return null;
}

/**
 * Root providers component wrapping the application with all necessary context.
 *
 * @param props.minimalChrome - When true (e.g. /research, /ticker): skip auth,
 *   PostHog, onboarding, SSE listeners — avoids errors on public/embed pages.
 */
export function Providers({
  children,
  minimalChrome = false,
}: {
  children: React.ReactNode;
  minimalChrome?: boolean;
}) {
  const [mounted, setMounted] = useState(false);
  const devAuthSession = getBrowserDevAuthSession();

  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  if (minimalChrome) {
    return (
      <div suppressHydrationWarning>
        <EmbedModeProvider>
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange={false}
          >
            <TooltipProvider delayDuration={200}>
              <DevThemeToggle />
              <FontSizeProvider>
                <QueryClientProvider client={queryClient}>
                  <GamePlaybackManager />
                  <WidgetRefreshProvider>
                    {mounted ? (
                      <Fragment>{children}</Fragment>
                    ) : (
                      <div className="min-h-dvh bg-background md:min-h-screen" />
                    )}
                  </WidgetRefreshProvider>
                </QueryClientProvider>
              </FontSizeProvider>
            </TooltipProvider>
          </ThemeProvider>
        </EmbedModeProvider>
      </div>
    );
  }

  const fullProviders = (
    <StewardAuthProvider>
      <FarcasterMiniAppProvider>
        <TelegramMiniAppProvider>
          <DiscordActivityProvider>
            <PostHogIdentifier />
            <Suspense fallback={null}>
              <ReferralCaptureProvider />
            </Suspense>
            <OnboardingProvider>
              <SessionHeartbeatProvider>
                <AutoDailyRewardProvider>
                  <GameGuideProvider>
                    <OutcomeNotificationProvider>
                      <WidgetRefreshProvider>
                        {mounted ? (
                          <Fragment>{children}</Fragment>
                        ) : (
                          <div className="min-h-dvh bg-sidebar md:min-h-screen" />
                        )}
                      </WidgetRefreshProvider>
                    </OutcomeNotificationProvider>
                  </GameGuideProvider>
                </AutoDailyRewardProvider>
              </SessionHeartbeatProvider>
            </OnboardingProvider>
          </DiscordActivityProvider>
        </TelegramMiniAppProvider>
      </FarcasterMiniAppProvider>
    </StewardAuthProvider>
  );

  // Dev auth path — skip Steward's own session storage (bearer token injected manually)
  if (devAuthSession) {
    return (
      <div suppressHydrationWarning>
        <EmbedModeProvider>
          <PostHogErrorBoundary>
            <Suspense fallback={null}>
              <PostHogProvider>
                <ThemeProvider
                  attribute="class"
                  defaultTheme="system"
                  enableSystem
                  disableTransitionOnChange={false}
                >
                  <TooltipProvider delayDuration={200}>
                    <DevThemeToggle />
                    <FontSizeProvider>
                      <QueryClientProvider client={queryClient}>
                        <GamePlaybackManager />
                        <ChatCacheHydrator />
                        {fullProviders}
                      </QueryClientProvider>
                    </FontSizeProvider>
                  </TooltipProvider>
                </ThemeProvider>
              </PostHogProvider>
            </Suspense>
          </PostHogErrorBoundary>
        </EmbedModeProvider>
      </div>
    );
  }

  return (
    <div suppressHydrationWarning>
      <EmbedModeProvider>
        <PostHogErrorBoundary>
          <Suspense fallback={null}>
            <PostHogProvider>
              <ThemeProvider
                attribute="class"
                defaultTheme="system"
                enableSystem
                disableTransitionOnChange={false}
              >
                <TooltipProvider delayDuration={200}>
                  <DevThemeToggle />
                  <FontSizeProvider>
                    <QueryClientProvider client={queryClient}>
                      <GamePlaybackManager />
                      <ChatCacheHydrator />
                      {fullProviders}
                    </QueryClientProvider>
                  </FontSizeProvider>
                </TooltipProvider>
              </ThemeProvider>
            </PostHogProvider>
          </Suspense>
        </PostHogErrorBoundary>
      </EmbedModeProvider>
    </div>
  );
}
