/**
 * Push notification setup for Capacitor mobile app.
 *
 * Handles:
 * - Permission request
 * - Token registration with the Feed API
 * - Foreground notification display
 * - Notification tap → in-app navigation
 *
 * Requires:
 * - @capacitor/push-notifications plugin
 * - A server-side push infrastructure (Firebase Cloud Messaging for Android,
 *   APNs for iOS) — NOT included in this file
 * - A POST /api/notifications/register-device endpoint on the API server
 */

import { apiUrl } from "@/utils/api-url";
import { getPlatform, isNativePlatform } from "./platform";

interface PushSetupOptions {
  /** Function to get the current auth token for API calls */
  getAccessToken: () => Promise<string | null>;
  /** Function to navigate to a path when a notification is tapped */
  navigate: (path: string) => void;
}

/**
 * Initialize push notifications.
 *
 * Call this once after the user logs in. It requests permission,
 * registers the device token with the API, and sets up listeners
 * for incoming notifications and tap actions.
 */
export async function initPushNotifications({
  getAccessToken,
  navigate,
}: PushSetupOptions): Promise<void> {
  if (!isNativePlatform()) return;

  const { PushNotifications } = await import("@capacitor/push-notifications");

  const permission = await PushNotifications.requestPermissions();
  if (permission.receive !== "granted") return;

  await PushNotifications.register();

  // When the device gets a push token from APNs/FCM, send it to our API
  PushNotifications.addListener("registration", async (token) => {
    const authToken = await getAccessToken();
    if (!authToken) return;

    await fetch(apiUrl("/api/notifications/register-device"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        platform: getPlatform(),
        token: token.value,
      }),
    });
  });

  // Handle notification received while app is in foreground
  PushNotifications.addListener(
    "pushNotificationReceived",
    (_notification) => {},
  );

  // Handle notification tap (user tapped a notification from the OS)
  PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
    const data = action.notification.data as Record<string, string>;
    // Navigate to the relevant screen based on notification data
    const path = data?.path || data?.url;
    if (path) {
      navigate(path);
    }
  });
}

/**
 * Remove the device's push token from the API (call on logout).
 */
export async function unregisterPushNotifications(
  getAccessToken: () => Promise<string | null>,
): Promise<void> {
  if (!isNativePlatform()) return;

  const authToken = await getAccessToken();
  if (!authToken) return;

  await fetch(apiUrl("/api/notifications/unregister-device"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ platform: getPlatform() }),
  });
}
