/**
 * Single source of truth mapping a notification category to its lucide icon,
 * used by every notification surface so category iconography stays consistent.
 */
import type { NotificationCategory } from "@elizaos/core";
import {
  Bot,
  Check,
  CircleAlert,
  Clock,
  FileWarning,
  HeartPulse,
  MessageSquare,
  Settings2,
  Workflow,
} from "lucide-react";
import type { ReactNode } from "react";

/**
 * The single source of truth mapping a notification's {@link NotificationCategory}
 * to its icon, consumed by the dashboard notification center so every surface
 * renders the same iconography (#10697).
 */
export const CATEGORY_ICON: Record<NotificationCategory, ReactNode> = {
  reminder: <Clock className="size-4" />,
  task: <Check className="size-4" />,
  workflow: <Workflow className="size-4" />,
  agent: <Bot className="size-4" />,
  approval: <FileWarning className="size-4" />,
  message: <MessageSquare className="size-4" />,
  health: <HeartPulse className="size-4" />,
  system: <Settings2 className="size-4" />,
  general: <CircleAlert className="size-4" />,
};

/** Resolve a category to its icon, falling back to the `general` icon. */
export function categoryIcon(category: NotificationCategory): ReactNode {
  return CATEGORY_ICON[category] ?? CATEGORY_ICON.general;
}
