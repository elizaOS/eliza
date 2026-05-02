/**
 * Eliza avatar component with consistent fallback behavior.
 * Shows custom avatar if provided, otherwise shows the default Eliza avatar.
 *
 * @param props - Eliza avatar configuration
 * @param props.avatarUrl - Optional custom avatar URL
 * @param props.name - Optional name for alt text
 * @param props.className - Additional classes for the Avatar wrapper
 * @param props.fallbackClassName - Additional classes for the AvatarFallback
 * @param props.iconClassName - Additional classes for the avatar image
 * @param props.animate - Whether to animate the avatar with pulse
 */

"use client";

import Image from "@elizaos/cloud-ui/runtime/image";
import { memo } from "react";
import { cn } from "@/lib/utils";
import { ensureAvatarUrl, isBuiltInAvatar } from "@/lib/utils/default-avatar";

interface ElizaAvatarProps {
  avatarUrl?: string;
  name?: string;
  className?: string;
  fallbackClassName?: string;
  iconClassName?: string;
  animate?: boolean;
  /** Set to true for above-the-fold images to improve LCP */
  priority?: boolean;
}

/**
 * Reusable Eliza avatar component with consistent fallback behavior.
 * Shows custom avatar if provided, otherwise shows the default Eliza avatar.
 */
export const ElizaAvatar = memo(function ElizaAvatar({
  avatarUrl,
  name = "Eliza",
  className,
  iconClassName,
  animate = false,
  priority = false,
}: ElizaAvatarProps) {
  const resolvedAvatarUrl = ensureAvatarUrl(avatarUrl, name);

  return (
    <div className={cn("relative flex shrink-0 overflow-hidden rounded-full", className)}>
      <Image
        key={resolvedAvatarUrl}
        src={resolvedAvatarUrl}
        alt={name}
        fill
        className={cn("object-cover", animate ? "animate-pulse" : "", iconClassName)}
        sizes="48px"
        priority={priority}
        unoptimized={!isBuiltInAvatar(resolvedAvatarUrl)}
      />
    </div>
  );
});
