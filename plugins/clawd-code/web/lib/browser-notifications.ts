export interface BrowserNotificationOptions {
  title: string;
  body?: string;
  onClick?: () => void;
}

class BrowserNotificationService {
  async requestPermission(): Promise<boolean> {
    if (typeof window === "undefined") return false;
    if (!("Notification" in window)) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;

    const result = await Notification.requestPermission();
    return result === "granted";
  }

  async send(options: BrowserNotificationOptions): Promise<void> {
    if (typeof window === "undefined") return;
    if (!("Notification" in window)) return;
    // Only notify when the tab is in the background
    if (!document.hidden) return;

    const granted = await this.requestPermission();
    if (!granted) return;

    const n = new Notification(options.title, {
      body: options.body,
      icon: "/favicon.ico",
    });

    n.onclick = () => {
      window.focus();
      options.onClick?.();
      n.close();
    };
  }

  getPermission(): NotificationPermission {
    if (typeof window === "undefined") return "default";
    if (!("Notification" in window)) return "denied";
    return Notification.permission;
  }

  isSupported(): boolean {
    return typeof window !== "undefined" && "Notification" in window;
  }
}

export const browserNotifications = new BrowserNotificationService();
