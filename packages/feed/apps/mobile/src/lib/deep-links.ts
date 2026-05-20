/**
 * Deep link handling for the Capacitor mobile app.
 *
 * Handles two types of deep links:
 * 1. Privy OAuth redirects (handled by AppUrlListener — not here)
 * 2. App content links (feed.market/post/123 → navigate to /post/123)
 *
 * This module provides the initialization for Android back button handling
 * and app lifecycle events.
 */

import { isNativePlatform } from './platform';

interface DeepLinkOptions {
  navigate: (path: string) => void;
}

/**
 * Initialize app lifecycle handlers for Capacitor.
 *
 * - Back button: navigate back in history or minimize app
 * - App state change: handle resume from background
 */
export async function initAppLifecycle({
  navigate,
}: DeepLinkOptions): Promise<void> {
  if (!isNativePlatform()) return;

  const { App } = await import('@capacitor/app');

  // Handle Android back button
  App.addListener('backButton', ({ canGoBack }) => {
    if (canGoBack) {
      window.history.back();
    } else {
      // At root — minimize the app instead of closing
      App.minimizeApp();
    }
  });

  // Handle app resume from background
  App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) {
    }
  });
}
