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
 * to its icon. Both the popover `NotificationCenter` and the home
 * `NotificationsWidget` consume this, so the two surfaces can never drift (#10697).
 */
export const CATEGORY_ICON: Record<NotificationCategory, ReactNode> = {
  reminder: <Clock className="h-4 w-4" />,
  task: <Check className="h-4 w-4" />,
  workflow: <Workflow className="h-4 w-4" />,
  agent: <Bot className="h-4 w-4" />,
  approval: <FileWarning className="h-4 w-4" />,
  message: <MessageSquare className="h-4 w-4" />,
  health: <HeartPulse className="h-4 w-4" />,
  system: <Settings2 className="h-4 w-4" />,
  general: <CircleAlert className="h-4 w-4" />,
};

/** Resolve a category to its icon, falling back to the `general` icon. */
export function categoryIcon(category: NotificationCategory): ReactNode {
  return CATEGORY_ICON[category] ?? CATEGORY_ICON.general;
}
