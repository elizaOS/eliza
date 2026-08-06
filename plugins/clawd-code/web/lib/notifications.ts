import { create } from "zustand";
import { persist } from "zustand/middleware";
import { nanoid } from "nanoid";

export type ToastVariant = "success" | "error" | "warning" | "info" | "loading";
export type NotificationCategory = "error" | "activity" | "system";

export interface ToastItem {
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
  duration: number; // ms, 0 = no auto-dismiss
  action?: { label: string; onClick: () => void };
  details?: string;
  createdAt: number;
}

export interface NotificationItem {
  id: string;
  title: string;
  description: string;
  category: NotificationCategory;
  link?: string;
  read: boolean;
  createdAt: number;
}

const MAX_VISIBLE_TOASTS = 5;
const MAX_NOTIFICATIONS = 100;

export const DEFAULT_DURATIONS: Record<ToastVariant, number> = {
  success: 5000,
  info: 5000,
  warning: 7000,
  error: 10000,
  loading: 0,
};

interface NotificationStore {
  // Toast state
  toasts: ToastItem[];
  toastQueue: ToastItem[];
  // Notification center state
  notifications: NotificationItem[];
  // Preferences
  browserNotificationsEnabled: boolean;
  soundEnabled: boolean;

  // Toast actions
  addToast: (options: Omit<ToastItem, "id" | "createdAt">) => string;
  dismissToast: (id: string) => void;
  dismissAllToasts: () => void;

  // Notification actions
  addNotification: (options: Omit<NotificationItem, "id" | "read" | "createdAt">) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clearHistory: () => void;

  // Preference actions
  setBrowserNotificationsEnabled: (enabled: boolean) => void;
  setSoundEnabled: (enabled: boolean) => void;
}

export const useNotificationStore = create<NotificationStore>()(
  persist(
    (set) => ({
      toasts: [],
      toastQueue: [],
      notifications: [],
      browserNotificationsEnabled: true,
      soundEnabled: false,

      addToast: (options) => {
        const id = nanoid();
        const toast: ToastItem = { ...options, id, createdAt: Date.now() };
        set((state) => {
          if (state.toasts.length < MAX_VISIBLE_TOASTS) {
            return { toasts: [...state.toasts, toast] };
          }
          return { toastQueue: [...state.toastQueue, toast] };
        });
        return id;
      },

      dismissToast: (id) => {
        set((state) => {
          const toasts = state.toasts.filter((t) => t.id !== id);
          const [next, ...queue] = state.toastQueue;
          if (next) {
            return { toasts: [...toasts, next], toastQueue: queue };
          }
          return { toasts };
        });
      },

      dismissAllToasts: () => {
        set({ toasts: [], toastQueue: [] });
      },

      addNotification: (options) => {
        const notification: NotificationItem = {
          ...options,
          id: nanoid(),
          read: false,
          createdAt: Date.now(),
        };
        set((state) => ({
          notifications: [notification, ...state.notifications].slice(0, MAX_NOTIFICATIONS),
        }));
      },

      markRead: (id) => {
        set((state) => ({
          notifications: state.notifications.map((n) =>
            n.id === id ? { ...n, read: true } : n
          ),
        }));
      },

      markAllRead: () => {
        set((state) => ({
          notifications: state.notifications.map((n) => ({ ...n, read: true })),
        }));
      },

      clearHistory: () => {
        set({ notifications: [] });
      },

      setBrowserNotificationsEnabled: (enabled) => {
        set({ browserNotificationsEnabled: enabled });
      },

      setSoundEnabled: (enabled) => {
        set({ soundEnabled: enabled });
      },
    }),
    {
      name: "claude-code-notifications",
      partialize: (state) => ({
        notifications: state.notifications,
        browserNotificationsEnabled: state.browserNotificationsEnabled,
        soundEnabled: state.soundEnabled,
      }),
    }
  )
);
