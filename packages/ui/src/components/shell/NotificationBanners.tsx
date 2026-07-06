/**
 * Top-of-screen notification banners — the iOS/Android "heads-up" surface. When
 * a live notification arrives, the store's delivery path queues it in the
 * banner store; this renders that queue as a stack of glass cards that slide
 * down from the top, auto-dismiss after a priority-scaled dwell, and open the
 * notification's view on tap. It is separate from the persistent home inbox
 * (NotificationsHomeCenter) and from the bottom `setActionNotice` toast used by
 * other surfaces: a banner is the momentary alert; the inbox is the record.
 *
 * Portal-mounted at the shell-overlay z-layer and only while the queue is
 * non-empty, so at rest the app pays zero DOM cost.
 */
import type { AgentNotification } from "@elizaos/core";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Z_SHELL_OVERLAY } from "../../lib/floating-layers";
import { cn } from "../../lib/utils";
import { TOAST_TTL_MS } from "../../state/action-notice";
import {
  isSafeDeepLink,
  navigateDeepLink,
} from "../../state/notifications/navigate-deep-link";
import {
  dismissNotificationBanner,
  useNotificationBanners,
} from "../../state/notifications/notification-banner-store";
import { markNotificationRead } from "../../state/notifications/notification-store";
import { RelativeTime } from "./RelativeTime";

// Slide down from the top + fade; an upward swipe/close scales it away. Opacity
// and transform only, fully stilled under prefers-reduced-motion.
const BANNER_CSS = `
@keyframes eliza-notif-banner-in {
  from { opacity: 0; transform: translateY(-14px) scale(0.98); }
  to   { opacity: 1; transform: none; }
}
.eliza-notif-banner { animation: eliza-notif-banner-in 260ms cubic-bezier(0.22,1,0.36,1) both; }
@media (prefers-reduced-motion: reduce) {
  .eliza-notif-banner { animation: none; }
}
`;

/** Dwell before auto-dismiss, scaled by how interruptive the arrival is. */
function dwellMs(priority: AgentNotification["priority"]): number {
  return priority === "high" || priority === "urgent"
    ? TOAST_TTL_MS.notificationInterruptive
    : TOAST_TTL_MS.notification;
}

function BannerCard({
  notification,
}: {
  notification: AgentNotification;
}): React.JSX.Element {
  const urgent = notification.priority === "urgent";
  const high = notification.priority === "high";
  // Pause the auto-dismiss timer while the pointer is over the card so a banner
  // being read doesn't vanish mid-glance; it restarts on leave.
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (hovered) return undefined;
    const id = window.setTimeout(
      () => dismissNotificationBanner(notification.id),
      dwellMs(notification.priority),
    );
    return () => window.clearTimeout(id);
  }, [hovered, notification.id, notification.priority]);

  const open = () => {
    if (!notification.readAt) void markNotificationRead(notification.id);
    if (notification.deepLink && isSafeDeepLink(notification.deepLink)) {
      navigateDeepLink(notification.deepLink);
    }
    dismissNotificationBanner(notification.id);
  };

  return (
    <div
      className="eliza-notif-banner pointer-events-auto"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <div
        className={cn(
          // Glass card: translucent dark surface + hairline border + blur, the
          // iOS/Android banner idiom. `supports-[backdrop-filter]` keeps an
          // opaque-enough fallback where blur is unsupported.
          "group relative flex items-stretch overflow-hidden rounded-2xl border shadow-lg",
          "border-white/15 bg-black/55 text-white backdrop-blur-xl supports-[backdrop-filter]:bg-black/45",
          urgent && "border-red-400/40",
        )}
      >
        {/* Priority rail: urgent/high only, a 2px leading tint — restraint. */}
        {urgent || high ? (
          <span
            aria-hidden
            data-testid="notification-banner-accent"
            className={cn(
              "absolute inset-y-2 left-0 w-0.5 rounded-full",
              urgent ? "bg-red-400/80" : "bg-white/70",
            )}
          />
        ) : null}
        <button
          type="button"
          data-testid="notification-banner"
          aria-label={`${notification.title}${
            notification.body ? `. ${notification.body}` : ""
          }`}
          onClick={open}
          className="flex min-w-0 flex-1 flex-col gap-0.5 px-4 py-3 pr-10 text-left active:scale-[0.99] motion-reduce:active:scale-100"
        >
          <span className="flex items-baseline gap-1.5">
            <span className="truncate text-sm font-semibold">
              {notification.title}
            </span>
            <RelativeTime
              ts={notification.createdAt}
              className="ml-auto shrink-0 pl-2 text-2xs tabular-nums text-white/60"
            />
          </span>
          {notification.body ? (
            <span className="line-clamp-2 text-xs leading-snug text-white/70">
              {notification.body}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          aria-label="Dismiss notification"
          data-testid="notification-banner-dismiss"
          onClick={() => dismissNotificationBanner(notification.id)}
          className="absolute right-1.5 top-1.5 rounded-full p-1.5 text-white/55 transition-colors hover:bg-white/10 hover:text-white pointer-coarse:min-h-touch pointer-coarse:min-w-touch"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/** The live banner stack. Renders nothing while the queue is empty. */
export function NotificationBanners(): React.JSX.Element | null {
  const banners = useNotificationBanners();
  const portalTarget = useRef<HTMLElement | null>(null);
  if (typeof document === "undefined") return null;
  portalTarget.current ??= document.body;
  if (banners.length === 0) return null;

  return createPortal(
    <div
      data-testid="notification-banners"
      // Top-centered, non-interactive container (cards re-enable pointer events)
      // so the banners never block taps on the app behind the gaps between them.
      className="pointer-events-none fixed inset-x-0 top-0 z-[var(--z)] mx-auto flex w-full max-w-md flex-col gap-2 px-3 pt-[calc(env(safe-area-inset-top,0px)+0.5rem)]"
      style={{ ["--z" as string]: Z_SHELL_OVERLAY + 6 }}
    >
      <style>{BANNER_CSS}</style>
      {banners.map((n) => (
        <BannerCard key={n.id} notification={n} />
      ))}
    </div>,
    portalTarget.current,
  );
}
