"use client";

import { XCircle, Zap, Settings, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/utils";
import type { NotificationItem as NotificationItemType } from "@/lib/notifications";

interface NotificationItemProps {
  notification: NotificationItemType;
  onMarkRead: (id: string) => void;
}

const CATEGORY_CONFIG = {
  error: {
    icon: XCircle,
    iconColor: "text-red-400",
    bgColor: "bg-red-500/10",
  },
  activity: {
    icon: Zap,
    iconColor: "text-brand-400",
    bgColor: "bg-brand-500/10",
  },
  system: {
    icon: Settings,
    iconColor: "text-surface-400",
    bgColor: "bg-surface-700/40",
  },
} as const;

export function NotificationItem({ notification, onMarkRead }: NotificationItemProps) {
  const config = CATEGORY_CONFIG[notification.category];
  const Icon = config.icon;

  const handleClick = () => {
    if (!notification.read) {
      onMarkRead(notification.id);
    }
  };

  const content = (
    <div
      className={cn(
        "flex items-start gap-3 px-4 py-3 transition-colors cursor-pointer",
        "hover:bg-surface-800/60",
        !notification.read && "bg-surface-800/30"
      )}
      onClick={handleClick}
    >
      {/* Icon */}
      <div
        className={cn(
          "mt-0.5 shrink-0 w-7 h-7 rounded-full flex items-center justify-center",
          config.bgColor
        )}
      >
        <Icon className={cn("w-3.5 h-3.5", config.iconColor)} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <p
            className={cn(
              "text-sm leading-snug",
              notification.read ? "text-surface-300" : "text-surface-100 font-medium"
            )}
          >
            {notification.title}
          </p>
          <div className="flex items-center gap-1.5 shrink-0">
            {!notification.read && (
              <span className="w-1.5 h-1.5 rounded-full bg-brand-500 mt-1" />
            )}
            {notification.link && (
              <ExternalLink className="w-3 h-3 text-surface-500" />
            )}
          </div>
        </div>
        <p className="text-xs text-surface-500 mt-0.5 leading-relaxed line-clamp-2">
          {notification.description}
        </p>
        <p className="text-xs text-surface-600 mt-1">
          {formatDate(notification.createdAt)}
        </p>
      </div>
    </div>
  );

  if (notification.link) {
    return (
      <a href={notification.link} className="block no-underline">
        {content}
      </a>
    );
  }

  return content;
}
