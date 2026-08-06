"use client";

import { useState, useRef, useEffect } from "react";
import { Bell, CheckCheck, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useNotifications } from "@/hooks/useNotifications";
import { NotificationBadge } from "./NotificationBadge";
import { NotificationItem } from "./NotificationItem";
import type { NotificationCategory } from "@/lib/notifications";

type FilterCategory = "all" | NotificationCategory;

const FILTER_TABS: { key: FilterCategory; label: string }[] = [
  { key: "all", label: "All" },
  { key: "error", label: "Errors" },
  { key: "activity", label: "Activity" },
  { key: "system", label: "System" },
];

export function NotificationCenter() {
  const [isOpen, setIsOpen] = useState(false);
  const [activeFilter, setActiveFilter] = useState<FilterCategory>("all");
  const containerRef = useRef<HTMLDivElement>(null);

  const { notifications, unreadCount, markRead, markAllRead, clearHistory } =
    useNotifications();

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen]);

  const filtered =
    activeFilter === "all"
      ? notifications
      : notifications.filter((n) => n.category === activeFilter);

  return (
    <div ref={containerRef} className="relative">
      {/* Bell button */}
      <button
        onClick={() => setIsOpen((o) => !o)}
        className={cn(
          "relative p-1.5 rounded-md transition-colors",
          "text-surface-400 hover:text-surface-100 hover:bg-surface-800",
          isOpen && "bg-surface-800 text-surface-100"
        )}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
      >
        <Bell className="w-4 h-4" />
        <NotificationBadge count={unreadCount} />
      </button>

      {/* Panel */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.96 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className={cn(
              "absolute right-0 top-full mt-2 z-50",
              "w-80 rounded-lg border border-surface-700 shadow-2xl",
              "bg-surface-900 overflow-hidden",
              "flex flex-col"
            )}
            style={{ maxHeight: "480px" }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-surface-800">
              <h3 className="text-sm font-semibold text-surface-100">Notifications</h3>
              <div className="flex items-center gap-1">
                {unreadCount > 0 && (
                  <button
                    onClick={markAllRead}
                    className="p-1.5 rounded text-surface-500 hover:text-surface-200 hover:bg-surface-800 transition-colors"
                    title="Mark all as read"
                  >
                    <CheckCheck className="w-3.5 h-3.5" />
                  </button>
                )}
                {notifications.length > 0 && (
                  <button
                    onClick={clearHistory}
                    className="p-1.5 rounded text-surface-500 hover:text-surface-200 hover:bg-surface-800 transition-colors"
                    title="Clear all"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Filter tabs */}
            <div className="flex border-b border-surface-800 px-4">
              {FILTER_TABS.map((tab) => {
                const count =
                  tab.key === "all"
                    ? notifications.length
                    : notifications.filter((n) => n.category === tab.key).length;

                return (
                  <button
                    key={tab.key}
                    onClick={() => setActiveFilter(tab.key)}
                    className={cn(
                      "relative px-2 py-2.5 text-xs font-medium transition-colors mr-1",
                      activeFilter === tab.key
                        ? "text-surface-100"
                        : "text-surface-500 hover:text-surface-300"
                    )}
                  >
                    {tab.label}
                    {count > 0 && (
                      <span
                        className={cn(
                          "ml-1 text-[10px] px-1 py-0.5 rounded-full",
                          activeFilter === tab.key
                            ? "bg-brand-600 text-white"
                            : "bg-surface-700 text-surface-400"
                        )}
                      >
                        {count}
                      </span>
                    )}
                    {activeFilter === tab.key && (
                      <motion.div
                        layoutId="notification-tab-indicator"
                        className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand-500"
                      />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Notification list */}
            <div className="overflow-y-auto flex-1">
              {filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 gap-2">
                  <Bell className="w-8 h-8 text-surface-700" />
                  <p className="text-sm text-surface-500">No notifications</p>
                </div>
              ) : (
                <div className="divide-y divide-surface-800/60">
                  {filtered.map((n) => (
                    <NotificationItem
                      key={n.id}
                      notification={n}
                      onMarkRead={markRead}
                    />
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
