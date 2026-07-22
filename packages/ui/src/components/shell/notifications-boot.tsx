/**
 * Headless notification wiring for the app shell. Mounted once in App.tsx, it
 * boots the notification store (hydrate + live WS stream). Live arrivals fan out
 * to the OS/native sinks and the in-app top banner queue (rendered by
 * `NotificationBanners`); this module only needs to boot the store and answer
 * the surface-agnostic OPEN_NOTIFICATION_CENTER_EVENT (desktop menu/tray
 * "Notifications", the `<scheme>://notifications` deep link) by navigating to the
 * home dashboard — the NotificationsHomeCenter widget there IS the notification
 * center, so "open notifications" means "go to the dashboard".
 */
import { useEffect } from "react";
import { OPEN_NOTIFICATION_CENTER_EVENT } from "../../events";
import { useAppSelector } from "../../state";
import {
  initNotifications,
  seedDevNotificationsIfEmpty,
} from "../../state/notifications/notification-store";
import { initPushRegistration } from "../../state/notifications/push-registration";

/**
 * Boots data ingress independently of the paintable app shell. Startup, auth,
 * and first-run gates can keep AppContent on a full-screen surface while the
 * packaged desktop is already backgrounded; native notifications must not lose
 * their WebSocket subscription during that interval.
 */
export function NotificationsDataBoot(): null {
  useEffect(() => {
    initNotifications();
  }, []);
  return null;
}

export function NotificationsShellBoot(): null {
  const setTab = useAppSelector((s) => s.setTab);

  useEffect(() => {
    // Native-only, gated on granted permission, guarded against double-register.
    // The token POST is what makes the server's APNs/FCM stack a live pipeline.
    void initPushRegistration();
    // Dev builds only: paint the demo spread when the inbox is empty so the
    // inline home notification surface is visible by default while developing.
    // Prod bundles compile `import.meta.env.DEV` to false, so this is stripped.
    try {
      if (import.meta.env?.DEV) void seedDevNotificationsIfEmpty();
    } catch {
      // `import.meta.env` unavailable (non-Vite host) — treat as non-dev.
    }
  }, []);

  // Route every "open notifications" entry point to the combined home/apps
  // dashboard, where the notification widget is always inline.
  useEffect(() => {
    const onOpen = () => {
      setTab("chat");
    };
    window.addEventListener(OPEN_NOTIFICATION_CENTER_EVENT, onOpen);
    return () =>
      window.removeEventListener(OPEN_NOTIFICATION_CENTER_EVENT, onOpen);
  }, [setTab]);

  return null;
}
