import { useCallback } from "react";
import { posthog } from "@/lib/posthog";

type StringRecord = Record<
  string,
  string | number | boolean | null | undefined
>;

/**
 * Main PostHog analytics hook for tracking events throughout the app.
 *
 * Provides convenient methods for tracking various types of user interactions
 * and events. All events include automatic timestamps. Only tracks when
 * PostHog is initialized and in a browser environment.
 *
 * @returns An object containing tracking functions:
 * - `track`: Generic event tracking
 * - `trackAction`: Track user actions with automatic 'user_' prefix
 * - `trackNavigation`: Track page navigation events
 * - `trackClick`: Track button clicks
 * - `trackFormSubmit`: Track form submissions with success status
 * - `trackError`: Track errors and exceptions
 * - `posthog`: Direct access to PostHog client instance
 *
 * @example
 * ```tsx
 * const { track, trackClick, trackError } = usePostHog();
 *
 * const handleClick = () => {
 *   trackClick('buy_button', { marketId: '123' });
 * };
 * ```
 */
export function usePostHog() {
  // Track generic event
  const track = useCallback((event: string, properties?: StringRecord) => {
    if (posthog && typeof window !== "undefined") {
      posthog.capture(event, properties);
    }
  }, []);

  // Track user action (with automatic timestamp)
  const trackAction = useCallback(
    (action: string, properties?: StringRecord) => {
      track(`user_${action}`, {
        ...(properties || {}),
        timestamp: new Date().toISOString(),
      });
    },
    [track],
  );

  // Track navigation
  const trackNavigation = useCallback(
    (destination: string, source?: string) => {
      track("navigation", {
        destination,
        ...(source && { source }),
        timestamp: new Date().toISOString(),
      });
    },
    [track],
  );

  // Track button click
  const trackClick = useCallback(
    (buttonName: string, properties?: StringRecord) => {
      track("button_click", {
        button: buttonName,
        ...properties,
        timestamp: new Date().toISOString(),
      });
    },
    [track],
  );

  // Track form submission
  const trackFormSubmit = useCallback(
    (formName: string, success: boolean, properties?: StringRecord) => {
      track("form_submit", {
        form: formName,
        success,
        ...properties,
        timestamp: new Date().toISOString(),
      });
    },
    [track],
  );

  // Track error
  const trackError = useCallback(
    (error: Error | string, context?: Record<string, unknown>) => {
      const errorMessage = typeof error === "string" ? error : error.message;
      const errorStack = typeof error === "string" ? undefined : error.stack;

      track("$exception", {
        $exception_message: errorMessage,
        ...(errorStack && { $exception_stack: errorStack }),
        ...(context || {}),
        timestamp: new Date().toISOString(),
      });
    },
    [track],
  );

  return {
    track,
    trackAction,
    trackNavigation,
    trackClick,
    trackFormSubmit,
    trackError,
    posthog,
  };
}

/**
 * Hook for tracking signup and onboarding events.
 *
 * Specialized tracking functions for user registration and onboarding flows.
 * Helps measure conversion rates and identify drop-off points in the signup process.
 *
 * @returns Tracking functions for signup and onboarding events.
 *
 * @example
 * ```tsx
 * const { trackSignupStarted, trackSignupCompleted } = useSignupTracking();
 *
 * useEffect(() => {
 *   trackSignupStarted();
 * }, []);
 * ```
 */
export function useSignupTracking() {
  const { track } = usePostHog();

  const trackSignupStarted = useCallback(() => {
    track("signup_started", {
      timestamp: new Date().toISOString(),
    });
  }, [track]);

  const trackSignupCompleted = useCallback(
    (userId: string, properties?: Record<string, unknown>) => {
      track("signup_completed", {
        userId,
        ...properties,
        timestamp: new Date().toISOString(),
      });
    },
    [track],
  );

  const trackOnboardingStep = useCallback(
    (step: string, completed: boolean) => {
      track("onboarding_step", {
        step,
        completed,
        timestamp: new Date().toISOString(),
      });
    },
    [track],
  );

  const trackSocialConnect = useCallback(
    (platform: "farcaster" | "twitter", username: string) => {
      track("social_connect", {
        platform,
        username,
        timestamp: new Date().toISOString(),
      });
    },
    [track],
  );

  return {
    trackSignupStarted,
    trackSignupCompleted,
    trackOnboardingStep,
    trackSocialConnect,
  };
}

/**
 * Hook for tracking market and trading actions.
 *
 * Specialized tracking functions for market views, trades, and pool actions.
 * Helps analyze trading behavior and market engagement.
 *
 * @returns Tracking functions for market-related events.
 *
 * @example
 * ```tsx
 * const { trackMarketView, trackTrade } = useMarketTracking();
 *
 * useEffect(() => {
 *   trackMarketView(marketId, 'prediction');
 * }, [marketId]);
 * ```
 */
export function useMarketTracking() {
  const { track } = usePostHog();

  const trackMarketView = useCallback(
    (marketId: string, marketType: "prediction" | "perp") => {
      track("market_view", {
        marketId,
        marketType,
        timestamp: new Date().toISOString(),
      });
    },
    [track],
  );

  const trackTrade = useCallback(
    (
      action: "buy" | "sell" | "open" | "close",
      marketId: string,
      amount: number,
      success: boolean,
    ) => {
      track("trade", {
        action,
        marketId,
        amount,
        success,
        timestamp: new Date().toISOString(),
      });
    },
    [track],
  );

  const trackPoolAction = useCallback(
    (
      action: "deposit" | "withdraw",
      poolId: string,
      amount: number,
      success: boolean,
    ) => {
      track("pool_action", {
        action,
        poolId,
        amount,
        success,
        timestamp: new Date().toISOString(),
      });
    },
    [track],
  );

  return {
    trackMarketView,
    trackTrade,
    trackPoolAction,
  };
}

/**
 * Hook for tracking social interactions and content engagement.
 *
 * Specialized tracking functions for posts, likes, comments, follows, and shares.
 * Helps measure social engagement and content performance.
 *
 * @returns Tracking functions for social interaction events.
 *
 * @example
 * ```tsx
 * const { trackPostLike, trackFollow } = useSocialTracking();
 *
 * const handleLike = () => {
 *   trackPostLike(postId, true);
 * };
 * ```
 */
export function useSocialTracking() {
  const { track } = usePostHog();

  const trackPostCreated = useCallback(
    (postId: string, contentLength: number) => {
      track("post_created", {
        postId,
        contentLength,
        timestamp: new Date().toISOString(),
      });
    },
    [track],
  );

  const trackPostLike = useCallback(
    (postId: string, liked: boolean) => {
      track("post_like", {
        postId,
        action: liked ? "like" : "unlike",
        timestamp: new Date().toISOString(),
      });
    },
    [track],
  );

  const trackPostComment = useCallback(
    (postId: string, commentLength: number) => {
      track("post_comment", {
        postId,
        commentLength,
        timestamp: new Date().toISOString(),
      });
    },
    [track],
  );

  const trackFollow = useCallback(
    (targetUserId: string, followed: boolean) => {
      track("user_follow", {
        targetUserId,
        action: followed ? "follow" : "unfollow",
        timestamp: new Date().toISOString(),
      });
    },
    [track],
  );

  const trackShare = useCallback(
    (contentType: string, contentId: string) => {
      track("content_share", {
        contentType,
        contentId,
        timestamp: new Date().toISOString(),
      });
    },
    [track],
  );

  return {
    trackPostCreated,
    trackPostLike,
    trackPostComment,
    trackFollow,
    trackShare,
  };
}

/**
 * Hook for tracking page performance and API call metrics.
 *
 * Specialized tracking functions for measuring page load times and API
 * performance. Helps identify performance bottlenecks and optimize user experience.
 *
 * @returns Tracking functions for performance metrics.
 *
 * @example
 * ```tsx
 * const { trackPageLoad, trackAPICall } = usePerformanceTracking();
 *
 * useEffect(() => {
 *   const start = Date.now();
 *   // ... page loads ...
 *   trackPageLoad('home', Date.now() - start);
 * }, []);
 * ```
 */
export function usePerformanceTracking() {
  const { track } = usePostHog();

  const trackPageLoad = useCallback(
    (pageName: string, loadTime: number) => {
      track("page_load", {
        page: pageName,
        loadTime,
        timestamp: new Date().toISOString(),
      });
    },
    [track],
  );

  const trackAPICall = useCallback(
    (
      endpoint: string,
      method: string,
      duration: number,
      success: boolean,
      statusCode?: number,
    ) => {
      track("api_call", {
        endpoint,
        method,
        duration,
        success,
        ...(statusCode !== undefined && { statusCode }),
        timestamp: new Date().toISOString(),
      });
    },
    [track],
  );

  return {
    trackPageLoad,
    trackAPICall,
  };
}
