/**
 * Headless notification wiring for the app shell. Mounted once in App.tsx, it
 * boots the notification store (hydrate + live WS stream). Native platforms
 * may raise their OS notification, while the persistent Home notification
 * center is the only in-app surface. This module also answers the
 * surface-agnostic OPEN_NOTIFICATION_CENTER_EVENT (desktop menu/tray
 * "Notifications", the `<scheme>://notifications` deep link) by navigating to
 * Home.
 */

import { logger } from "@elizaos/logger";
import { useEffect } from "react";
import { client } from "../../api/client";
import { initLocalNotificationTapRouting } from "../../bridge/native-notifications";
import { OPEN_NOTIFICATION_CENTER_EVENT } from "../../events";
import { useAppSelector } from "../../state";
import { peekNotificationCenterOpenRequest } from "../../state/notifications/notification-center-open-request";
import {
  initNotifications,
  seedDevNotificationsIfEmpty,
} from "../../state/notifications/notification-store";
import {
  initPushRegistration,
  refreshPushRegistrationAuthority,
} from "../../state/notifications/push-registration";
import { goHome } from "../../state/shell-surface-store";

/**
 * Boots data ingress independently of the paintable app shell. Startup, auth,
 * and first-run gates can keep AppContent on a full-screen surface while the
 * packaged desktop is already backgrounded; native notifications must not lose
 * their WebSocket subscription during that interval.
 */
export function NotificationsDataBoot(): null {
  useEffect(() => {
    initNotifications();
    // Capacitor retains a notification action only until the first listener is
    // attached. This boot lives above AppContent's startup/auth early returns,
    // so install the listener here: a tap that launches into LoginView must be
    // retained by the canonical navigator instead of waiting for the signed-in
    // shell (which may never mount during this process lifetime).
    void initLocalNotificationTapRouting().catch((error: unknown) => {
      // error-policy:J1 native notification tap registration is a transport
      // boundary; a later top-level remount may retry after the bridge recovers.
      logger.error(
        { src: "local-notification-tap", error },
        "[local-notification-tap] failed to register native tap routing",
      );
    });
  }, []);
  return null;
}

export function NotificationsShellBoot(): null {
  const setTab = useAppSelector((s) => s.setTab);

  useEffect(() => {
    // Install the in-app destination before attaching the native bridge.
    // Capacitor may synchronously replay a retained cold-launch tap from
    // addListener(), so reversing this order would drop that first event.
    const onOpen = () => {
      goHome();
      setTab("chat");
    };
    window.addEventListener(OPEN_NOTIFICATION_CENTER_EVENT, onOpen);
    // A fallback AppDelegate URL can be replayed by getLaunchUrl() after the
    // root mounts but before this effect commits. The dispatcher retained that
    // request, so complete its navigation instead of waiting for another tap.
    if (peekNotificationCenterOpenRequest() !== null) {
      onOpen();
    }

    // Native-only, gated on granted permission, guarded against double-register.
    // The token POST is what makes the server's APNs/FCM stack a live pipeline.
    void initPushRegistration();
    const refreshAuthority = (force = false) => {
      void refreshPushRegistrationAuthority(undefined, force).catch(
        (error: unknown) => {
          // error-policy:J1 the shell transport boundary reports failed revoke or
          // re-registration without turning an authority switch into a UI crash.
          logger.error(
            { src: "push-registration", error },
            "[push-registration] failed to rotate device push authority",
          );
        },
      );
    };
    const onBaseAuthorityChange = () => refreshAuthority(true);
    const onTokenAuthorityChange = () => refreshAuthority();
    const unsubscribeBase = client.onBaseUrlChange(onBaseAuthorityChange);
    window.addEventListener("steward-token-sync", onTokenAuthorityChange);
    // Dev builds only: paint the demo spread when the inbox is empty so the
    // inline home notification surface is visible by default while developing.
    // Prod bundles compile `import.meta.env.DEV` to false, so this is stripped.
    try {
      if (import.meta.env?.DEV) void seedDevNotificationsIfEmpty();
    } catch {
      // `import.meta.env` unavailable (non-Vite host) — treat as non-dev.
    }
    return () => {
      unsubscribeBase();
      window.removeEventListener("steward-token-sync", onTokenAuthorityChange);
      window.removeEventListener(OPEN_NOTIFICATION_CENTER_EVENT, onOpen);
    };
  }, [setTab]);

  return null;
}
