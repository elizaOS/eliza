/**
 * Delivers renderer notifications through the desktop or mobile OS boundary.
 * A returned channel means the host accepted the request, not that the OS
 * displayed a banner: permissions, Focus, and placement remain system-owned.
 * Callers retain their inbox or render a viewport fallback when unavailable.
 */
import { Capacitor } from "@capacitor/core";
import { logger } from "@elizaos/logger";
import { invokeDesktopBridgeRequest } from "./electrobun-rpc";
import {
  type NativeNotificationRequest,
  showNativeNotification,
  showWebNotification,
} from "./native-notifications";

export async function deliverSystemNotification(
  request: NativeNotificationRequest,
  options: { allowHiddenWeb?: boolean } = {},
): Promise<"desktop" | "local" | "intent" | "web" | "none"> {
  try {
    const result = await invokeDesktopBridgeRequest<{ id: string }>({
      rpcMethod: "desktopShowNotification",
      ipcChannel: "desktop:showNotification",
      params: {
        title: request.title,
        body: request.body,
        urgency:
          request.priority === "urgent"
            ? "critical"
            : request.priority === "low"
              ? "low"
              : "normal",
        silent: request.silent ?? request.priority === "low",
      },
    });
    if (result !== null) return "desktop";
  } catch (error) {
    // error-policy:J4 native delivery unavailable; preserve the caller's fallback.
    logger.warn(
      { error },
      "[NotificationDelivery] Desktop channel unavailable",
    );
  }

  try {
    const native = await showNativeNotification(request);
    if (native !== "none") return native;
  } catch (error) {
    // error-policy:J4 mobile delivery unavailable; preserve the caller's fallback.
    logger.warn({ error }, "[NotificationDelivery] Mobile channel unavailable");
  }
  if (
    options.allowHiddenWeb &&
    !Capacitor.isNativePlatform() &&
    typeof document !== "undefined" &&
    (document.visibilityState !== "visible" || !document.hasFocus()) &&
    showWebNotification(request)
  ) {
    return "web";
  }
  return "none";
}
