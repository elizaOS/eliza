"use client";

import { cn } from "@/lib/utils";

interface NotificationBadgeProps {
  count: number;
  className?: string;
}

export function NotificationBadge({ count, className }: NotificationBadgeProps) {
  if (count <= 0) return null;

  return (
    <span
      className={cn(
        "absolute -top-1 -right-1 flex items-center justify-center",
        "min-w-[16px] h-4 px-1 rounded-full",
        "bg-brand-500 text-white text-[10px] font-bold leading-none",
        className
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
