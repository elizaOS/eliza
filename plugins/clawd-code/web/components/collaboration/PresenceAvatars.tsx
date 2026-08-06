"use client";

import { motion, AnimatePresence } from "framer-motion";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Wifi, WifiOff } from "lucide-react";
import { getInitials } from "@/lib/collaboration/presence";
import { labelForRole } from "@/lib/collaboration/permissions";
import { useCollaborationContextOptional } from "./CollaborationProvider";
import { cn } from "@/lib/utils";

// ─── Single Avatar ────────────────────────────────────────────────────────────

interface AvatarProps {
  name: string;
  color: string;
  avatar?: string;
  role: import("@/lib/collaboration/socket").CollabRole;
  isActive?: boolean;
}

function UserAvatar({ name, color, avatar, role, isActive = true }: AvatarProps) {
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <div
            className="relative w-7 h-7 rounded-full flex-shrink-0 cursor-default select-none"
            style={{ boxShadow: `0 0 0 2px ${color}` }}
          >
            {avatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatar}
                alt={name}
                className="w-full h-full rounded-full object-cover"
              />
            ) : (
              <div
                className="w-full h-full rounded-full flex items-center justify-center text-[10px] font-semibold text-white"
                style={{ backgroundColor: color }}
              >
                {getInitials(name)}
              </div>
            )}

            {/* Online indicator dot */}
            {isActive && (
              <span className="absolute bottom-0 right-0 w-2 h-2 rounded-full bg-green-400 border border-surface-900" />
            )}
          </div>
        </Tooltip.Trigger>

        <Tooltip.Portal>
          <Tooltip.Content
            side="bottom"
            sideOffset={6}
            className={cn(
              "z-50 rounded-md px-2.5 py-1.5 text-xs shadow-md",
              "bg-surface-800 border border-surface-700 text-surface-100"
            )}
          >
            <p className="font-medium">{name}</p>
            <p className="text-surface-400">{labelForRole(role)}</p>
            <Tooltip.Arrow className="fill-surface-800" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

// ─── PresenceAvatars ──────────────────────────────────────────────────────────

export function PresenceAvatars() {
  const ctx = useCollaborationContextOptional();
  if (!ctx) return null;

  const { isConnected, otherUsers, currentUser } = ctx;
  // Show at most 4 avatars + overflow badge
  const MAX_VISIBLE = 4;
  const allUsers = [currentUser, ...otherUsers];
  const visible = allUsers.slice(0, MAX_VISIBLE);
  const overflow = allUsers.length - MAX_VISIBLE;

  return (
    <div className="flex items-center gap-2">
      {/* Connection indicator */}
      <div className="flex items-center gap-1.5">
        {isConnected ? (
          <Wifi className="w-3.5 h-3.5 text-green-400" />
        ) : (
          <WifiOff className="w-3.5 h-3.5 text-surface-500 animate-pulse" />
        )}
        <span className="text-xs text-surface-500 hidden sm:inline">
          {isConnected
            ? `${allUsers.length} online`
            : "Reconnecting…"}
        </span>
      </div>

      {/* Stacked avatars */}
      <div className="flex items-center">
        <AnimatePresence>
          {visible.map((user, i) => (
            <motion.div
              key={user.id}
              initial={{ opacity: 0, scale: 0.5, x: -8 }}
              animate={{ opacity: 1, scale: 1, x: 0 }}
              exit={{ opacity: 0, scale: 0.5 }}
              transition={{ duration: 0.2, delay: i * 0.04 }}
              style={{ zIndex: visible.length - i, marginLeft: i === 0 ? 0 : -8 }}
            >
              <UserAvatar
                name={user.id === currentUser.id ? `${user.name} (you)` : user.name}
                color={user.color}
                avatar={user.avatar}
                role={user.role}
              />
            </motion.div>
          ))}
        </AnimatePresence>

        {overflow > 0 && (
          <div
            className={cn(
              "w-7 h-7 rounded-full -ml-2 z-0 flex items-center justify-center",
              "bg-surface-700 border-2 border-surface-900 text-[10px] font-medium text-surface-300"
            )}
          >
            +{overflow}
          </div>
        )}
      </div>
    </div>
  );
}
