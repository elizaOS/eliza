/**
 * Headless notification wiring for the app shell. Mounted once in App.tsx, it
 * boots the notification store (hydrate + live WS stream), routes interrupt
 * toasts through the shell's ActionNotice, and answers the surface-agnostic
 * OPEN_NOTIFICATION_CENTER_EVENT (desktop menu/tray "Notifications", the
 * `<scheme>://notifications` deep link) by navigating to the home dashboard —
 * the NotificationsHomeCenter widget there IS the notification center, so
 * "open notifications" means "go to the dashboard".
 */
import { useEffect } from "react";
import { OPEN_NOTIFICATION_CENTER_EVENT } from "../../events";
import { useAppSelector } from "../../state";
import {
  initNotifications,
  registerNotificationToastSink,
} from "../../state/notifications/notification-store";
import { goHome } from "../../state/shell-surface-store";

export function NotificationsShellBoot(): null {
  const setActionNotice = useAppSelector((s) => s.setActionNotice);
  const setTab = useAppSelector((s) => s.setTab);

  // Idempotent store boot — the store guards against re-init.
  useEffect(() => {
    initNotifications();
  }, []);

  // The single shared toast sink: interrupt-worthy notifications surface as
  // transient ActionNotice toasts. Re-pointed if the shell remounts.
  useEffect(() => {
    registerNotificationToastSink(setActionNotice);
    return () => registerNotificationToastSink(null);
  }, [setActionNotice]);

  // Route every "open notifications" entry point to the dashboard: the combined
  // Home/Launcher route on its Home half, where the notification widget lives.
  useEffect(() => {
    const onOpen = () => {
      setTab("chat");
      goHome();
    };
    window.addEventListener(OPEN_NOTIFICATION_CENTER_EVENT, onOpen);
    return () =>
      window.removeEventListener(OPEN_NOTIFICATION_CENTER_EVENT, onOpen);
  }, [setTab]);

  return null;
}
