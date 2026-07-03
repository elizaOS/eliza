import type { AgentNotification, NotificationCategory } from "@elizaos/core";
import { Bell, BellRing, CheckCheck, Inbox, Trash2, X } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  type BackIntentEventDetail,
  ELIZA_BACK_INTENT_EVENT,
  OPEN_NOTIFICATION_CENTER_EVENT,
} from "../../events";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import {
  Z_NOTIFICATION_BACKDROP,
  Z_NOTIFICATION_OVERLAY,
} from "../../lib/floating-layers";
import { cn } from "../../lib/utils";
import { useAppSelector } from "../../state";
import { categoryIcon } from "../../state/notifications/category-icon";
import { navigateDeepLink } from "../../state/notifications/navigate-deep-link";
import {
  clearNotifications,
  initNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  registerNotificationToastSink,
  removeNotification,
  useNotifications,
} from "../../state/notifications/notification-store";
import { formatRelativeTime } from "../../utils/format";
import { rankHomeNotifications } from "../../widgets/home-priority";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

type NotificationSortMode = "priority" | "time";

const CATEGORY_LABEL: Record<NotificationCategory, string> = {
  reminder: "Reminders",
  task: "Tasks",
  workflow: "Workflows",
  agent: "Agents",
  approval: "Approvals",
  message: "Messages",
  health: "Health",
  system: "System",
  general: "General",
};

/** Stable display order for the category filter chips. */
const CATEGORY_ORDER: NotificationCategory[] = [
  "approval",
  "agent",
  "task",
  "workflow",
  "reminder",
  "message",
  "health",
  "system",
  "general",
];

type CategoryFilter = NotificationCategory | "all";

/**
 * The controlled overlay renders as one of two surface-appropriate shells.
 * Mouse-driven wide surfaces (desktop shell + desktop browser) get a native
 * top-RIGHT anchored `panel`; touch phones/tablets and narrow windows get the
 * full-width top pull-down `sheet` (#10706).
 *
 * Detection reuses the fine-pointer convention already used for the pager edge
 * buttons ({@link ../shell/PagerEdgeButtons}); the `min-width` gate keeps a
 * narrow desktop window (where a 400px right-anchored panel would crowd the
 * viewport) on the centered sheet instead.
 */
const DESKTOP_PANEL_QUERY =
  "(hover: hover) and (pointer: fine) and (min-width: 640px)";

/**
 * Short landscape phones: shrink the pull-down sheet so it floats over the
 * (already short) viewport instead of covering nearly all of it.
 */
const SHORT_LANDSCAPE_QUERY =
  "(orientation: landscape) and (max-height: 520px)";

/**
 * Render a controlled overlay (sheet / panel) into `document.body` so its
 * `position: fixed` is viewport-relative. The home↔launcher rail sets a paging
 * `transform` on a `w-[200%]` element, and a transformed ancestor becomes the
 * containing block for `fixed` descendants — without this portal the sheet/panel
 * anchor to the 2×-wide rail and render clipped off-screen to the right (the
 * "notifications look broken" bug). The bell popover already escapes via Radix's
 * own portal; this gives the controlled shells the same viewport anchoring.
 */
function overlayPortal(node: ReactNode): ReactNode {
  if (typeof document === "undefined" || !document.body) return node;
  return createPortal(node, document.body);
}

function NotificationRow({
  notification,
  onClose,
}: {
  notification: AgentNotification;
  onClose: () => void;
}): ReactNode {
  const unread = !notification.readAt;
  const handleOpen = useCallback(() => {
    if (unread) void markNotificationRead(notification.id);
    if (notification.deepLink) {
      navigateDeepLink(notification.deepLink);
      onClose();
    }
  }, [notification.deepLink, notification.id, onClose, unread]);

  const handleRemove = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      void removeNotification(notification.id);
    },
    [notification.id],
  );

  return (
    // iOS-notification-center card: each notification is its own rounded
    // translucent glass tile over the blurred shell (the shell carries the ONE
    // backdrop-blur — per-card blur would stack GPU filters on the phone).
    <li
      className={cn(
        "group relative flex items-start gap-3 rounded-2xl bg-white/10 pr-9 transition-colors hover:bg-white/15 pointer-coarse:pr-12",
        unread && "bg-white/15",
      )}
    >
      <button
        type="button"
        onClick={handleOpen}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-2xl px-3 py-2.5 text-left"
      >
        <span
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
            notification.priority === "urgent"
              ? "bg-status-danger/20 text-status-danger"
              : notification.priority === "high"
                ? "bg-accent/20 text-accent"
                : "bg-white/15 text-white/85",
          )}
        >
          {categoryIcon(notification.category)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-white">
              {notification.title}
            </span>
            {unread && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
            )}
          </span>
          {notification.body && (
            <span className="mt-0.5 line-clamp-2 block text-xs text-white/70">
              {notification.body}
            </span>
          )}
          <span className="mt-1 block text-[11px] text-white/50">
            {formatRelativeTime(notification.createdAt)}
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={handleRemove}
        // Visible at rest (dimmed): on touch there is no hover, and an
        // invisible-but-hit-testable X silently deleted the notification on a
        // near-edge tap. Full opacity on hover; keyboard focus visibility is
        // the app-wide global treatment (per-component focus utilities are
        // banned by no-focus-ring-gate). The glyph stays 22px on mouse, but on a
        // coarse pointer the hit target grows to the 44px `touch` token (the
        // house `pointer-coarse:min-*-touch` convention) so it isn't a
        // sub-target tap zone on the phone sheet.
        className="absolute right-1.5 top-2.5 flex shrink-0 items-center justify-center rounded-full p-1 text-white/60 opacity-50 transition-opacity pointer-coarse:min-h-touch pointer-coarse:min-w-touch hover:bg-white/10 hover:text-white group-hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

function CategoryFilterBar({
  categories,
  active,
  onSelect,
}: {
  categories: NotificationCategory[];
  active: CategoryFilter;
  onSelect: (next: CategoryFilter) => void;
}): ReactNode {
  return (
    // Flat — no divider line; rows separate by whitespace. These are filter
    // TOGGLES (they narrow the list below), not WAI-ARIA tabs — role="group" +
    // aria-pressed buttons, matching the adjacent sort toggle. A tablist would
    // promise roving-tabindex + arrow-key nav this bar doesn't implement.
    // `shrink-0`: this is a horizontal scroll container (overflow-x-auto → auto
    // min-height 0), so inside the flex-column shell it would otherwise be
    // crushed vertically when the list overflows; the list `ul` is the scroller.
    // biome-ignore lint/a11y/useSemanticElements: role="group" is correct for a labelled toolbar of filter toggles; <fieldset> is for grouped form fields, not a chip bar.
    <div
      className="flex shrink-0 items-center gap-1 overflow-x-auto px-2 py-1.5"
      role="group"
      aria-label="Filter notifications by category"
    >
      <FilterChip
        label="All"
        active={active === "all"}
        onSelect={() => onSelect("all")}
      />
      {categories.map((category) => (
        <FilterChip
          key={category}
          label={CATEGORY_LABEL[category]}
          icon={categoryIcon(category)}
          active={active === category}
          onSelect={() => onSelect(category)}
        />
      ))}
    </div>
  );
}

function FilterChip({
  label,
  icon,
  active,
  onSelect,
}: {
  label: string;
  icon?: ReactNode;
  active: boolean;
  onSelect: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-accent text-accent-foreground hover:bg-accent-hover"
          : "text-white/70 hover:bg-white/10 hover:text-white",
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/**
 * Notification center — a floating bell + unread badge that opens a panel
 * listing the agent's notifications. Self-contained: reads the notification
 * store, no props required. Mounted once in the app shell's persistent
 * overlay region so it is reachable from every view.
 *
 * `headless` boots the store + toast routing but renders no bell — used to keep
 * interrupt toasts flowing while the visible button is hidden. It is also the
 * single listener for {@link OPEN_NOTIFICATION_CENTER_EVENT}: on that event it
 * reveals the notification list in the surface-appropriate shell — the desktop
 * `panel` on mouse-driven wide surfaces, the pull-down `sheet` on touch.
 *
 * The controlled overlay shares one body across three shells: `variant="sheet"`
 * is the full-width top pull-down (home pull-DOWN gesture on mobile, #10706),
 * `variant="panel"` is the top-right anchored desktop/web dropdown, and the
 * default `variant="bell"` is the bell + popover. `open` / `onOpenChange` drive
 * the two controlled shells.
 */
export function NotificationCenter({
  className,
  headless = false,
  variant = "bell",
  open = false,
  onOpenChange,
}: {
  className?: string;
  headless?: boolean;
  variant?: "bell" | "sheet" | "panel" | "auto";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}): ReactNode {
  const { notifications, unreadCount, hydrated } = useNotifications();
  const setActionNotice = useAppSelector((s) => s.setActionNotice);
  const [activeCategory, setActiveCategory] = useState<CategoryFilter>("all");
  // Default to attention-first (unread → priority → recency); the user can flip
  // to a plain most-recent-first timeline (#10706).
  const [sortMode, setSortMode] = useState<NotificationSortMode>("priority");
  // The bell popover is CONTROLLED so a notification row that deep-links can
  // close it after navigating (an uncontrolled Radix Popover stays open over the
  // new view). Declared before any early return to respect the rules of hooks.
  const [bellOpen, setBellOpen] = useState(false);

  // Surface detection — drives which shell the headless owner opens and how the
  // pull-down sheet sizes itself. Both are reactive, so a resize/rotate while
  // the overlay is open re-picks the appropriate treatment.
  const isDesktopSurface = useMediaQuery(DESKTOP_PANEL_QUERY);
  const isShortLandscape = useMediaQuery(SHORT_LANDSCAPE_QUERY);

  // `variant="auto"` lets a controlled caller (e.g. HomeScreen's notification
  // pull-down) render the surface-appropriate shell without owning the media
  // query itself: the desktop top-right panel on mouse-driven wide surfaces, the
  // full-width pull-down sheet on touch/narrow. `bell` and the explicit
  // `sheet`/`panel` pass through unchanged.
  const effectiveVariant =
    variant === "auto" ? (isDesktopSurface ? "panel" : "sheet") : variant;

  // The two controlled shells (pull-down sheet + desktop panel) share the body,
  // an Escape/close contract, and a scrolling list; the bell popover is
  // self-bounded.
  const isControlled =
    effectiveVariant === "sheet" || effectiveVariant === "panel";

  // Categories actually present in the inbox, in a stable display order. Drives
  // the filter chips — empty/single-category inboxes get no filter clutter.
  const presentCategories = useMemo(() => {
    const present = new Set(notifications.map((n) => n.category));
    return CATEGORY_ORDER.filter((category) => present.has(category));
  }, [notifications]);

  // Fall back to "all" when the active category drains (its last item was read
  // away / cleared), so the list never shows an empty filtered view by accident.
  const effectiveCategory =
    activeCategory !== "all" && !presentCategories.includes(activeCategory)
      ? "all"
      : activeCategory;

  // Commit the drain fallback to state (not just the computed view): once a
  // filtered category empties, the filter is genuinely reset to "all". Without
  // this the stale `activeCategory` lingers, and a later notification of that
  // same category refilling `presentCategories` silently snaps the open shell
  // back to the old filter mid-read.
  useEffect(() => {
    if (
      activeCategory !== "all" &&
      !presentCategories.includes(activeCategory)
    ) {
      setActiveCategory("all");
    }
  }, [activeCategory, presentCategories]);

  const visibleNotifications = useMemo(() => {
    const filtered =
      effectiveCategory === "all"
        ? notifications
        : notifications.filter((n) => n.category === effectiveCategory);
    // Priority: reuse the home ranker (unread → priority → recency) so the two
    // surfaces agree. Time: a plain most-recent-first timeline. Both are pure +
    // stable, so equal items never reshuffle between renders.
    return sortMode === "priority"
      ? rankHomeNotifications(filtered)
      : [...filtered].sort((a, b) => b.createdAt - a.createdAt);
  }, [notifications, effectiveCategory, sortMode]);

  // Boot the notification store (hydrate + subscribe to the live stream) and
  // route its interrupt toasts through the shell's ActionNotice. Idempotent —
  // the store guards against re-init; the toast sink is re-pointed on remount.
  useEffect(() => {
    initNotifications();
    // Only the bell/headless owner (variant="bell") routes interrupt toasts —
    // the controlled shells the headless owner spawns (sheet + panel) are
    // transient readers and must not hijack (or null on unmount) the single
    // shared toast sink the always-mounted headless instance owns.
    if (effectiveVariant !== "bell") return;
    registerNotificationToastSink(setActionNotice);
    return () => registerNotificationToastSink(null);
  }, [setActionNotice, effectiveVariant]);

  const handleMarkAll = useCallback(() => {
    void markAllNotificationsRead();
  }, []);
  const handleClear = useCallback(() => {
    void clearNotifications();
  }, []);

  // Escape closes the controlled shells — sheet + panel (mirrors the popover's
  // dismiss). If a Radix dialog is stacked ON TOP (e.g. the Cmd+K command
  // palette opened over the panel), let that topmost layer consume the Escape
  // and peel one layer per press — the notification shell carries role="dialog"
  // WITHOUT data-state="open", so this guard never blocks its own dismissal.
  useEffect(() => {
    if (!isControlled || !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      onOpenChange?.(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isControlled, open, onOpenChange]);

  // Android hardware/gesture back closes whichever notification surface is open
  // FIRST (it is the topmost layer), so back never collapses the chat beneath it
  // or backgrounds the app while a modal notification shell is up. Registered
  // only while a shell is open; marks the intent handled so the chat overlay's
  // back handler + the native fall-through don't also fire.
  useEffect(() => {
    const shellOpen = (isControlled && open) || bellOpen;
    if (!shellOpen) return;
    const onBackIntent = (e: Event) => {
      const detail = (e as CustomEvent<BackIntentEventDetail>).detail;
      if (!detail || detail.handled) return;
      detail.handled = true;
      if (isControlled) onOpenChange?.(false);
      else setBellOpen(false);
    };
    window.addEventListener(ELIZA_BACK_INTENT_EVENT, onBackIntent);
    return () =>
      window.removeEventListener(ELIZA_BACK_INTENT_EVENT, onBackIntent);
  }, [isControlled, open, bellOpen, onOpenChange]);

  // Focus management for the controlled shells (sheet + panel). Unlike the bell
  // path (Radix Popover manages focus for us), these are hand-rolled dialogs
  // portaled to document.body, so we move focus IN on open, restore it to the
  // opener (home pull-zone button / tray trigger) on close, and trap Tab within
  // the dialog while open — the accessibility contract sibling overlays already
  // meet (e.g. TranscriptViewerOverlay).
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!isControlled || !open) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    // The portal renders in the same commit, so the ref is set by the time this
    // layout-adjacent effect runs.
    dialogRef.current?.focus();
    return () => {
      const toRestore = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (toRestore?.isConnected) toRestore.focus();
    };
  }, [isControlled, open]);

  // Wrap Tab within the dialog so keyboard focus can't walk out into the
  // backgrounded app behind the overlay.
  const onDialogKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusables.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [],
  );

  // Surface-agnostic open (#10706): the single always-mounted headless instance
  // listens for OPEN_NOTIFICATION_CENTER_EVENT and reveals the pull-down sheet.
  // This is how desktop — where the floating bell is hidden — gets a visible
  // native way in (the "Notifications" menu/tray item and the
  // `<scheme>://notifications` deep link both dispatch this event). Only the
  // headless owner listens, so a transient pull-down/bell instance never double-
  // opens.
  const [selfOpen, setSelfOpen] = useState(false);
  useEffect(() => {
    if (!headless) return;
    const onOpen = () => setSelfOpen(true);
    window.addEventListener(OPEN_NOTIFICATION_CENTER_EVENT, onOpen);
    return () =>
      window.removeEventListener(OPEN_NOTIFICATION_CENTER_EVENT, onOpen);
  }, [headless]);

  const hasUnread = unreadCount > 0;

  // Hidden for now: keep the store + toast routing live (the effect above) but
  // render no bell. Drop the `headless` prop to bring the button back. When an
  // OPEN_NOTIFICATION_CENTER_EVENT has fired, the headless owner renders the
  // surface-appropriate controlled shell as a child (one level — no recursion):
  // the top-right desktop panel on mouse-driven wide surfaces, the full-width
  // pull-down sheet on touch/narrow ones.
  if (headless) {
    if (!selfOpen) return null;
    return (
      <NotificationCenter
        variant="auto"
        open
        onOpenChange={setSelfOpen}
        className={className}
      />
    );
  }

  const panelBody = (
    <>
      {/* Flat — no divider line under the header; whitespace + the type
          hierarchy separate it from the list (app-wide flat direction). */}
      <div className="flex items-center justify-between gap-2 px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-semibold text-white">
            Notifications
          </span>
          {hasUnread && (
            <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-2xs font-semibold leading-none text-accent">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {hasUnread && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Mark all read"
              title="Mark all read"
              className="text-white/70 hover:bg-white/10 hover:text-white"
              onClick={handleMarkAll}
            >
              <CheckCheck className="h-4 w-4" />
            </Button>
          )}
          {notifications.length > 0 && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Clear all"
              title="Clear all"
              className="text-white/70 hover:bg-white/10 hover:text-white"
              onClick={handleClear}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          {isControlled && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close notifications"
              title="Close"
              className="text-white/70 hover:bg-white/10 hover:text-white"
              data-testid={
                effectiveVariant === "panel"
                  ? "notification-panel-close"
                  : "notification-sheet-close"
              }
              onClick={() => onOpenChange?.(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      {presentCategories.length > 1 && (
        <CategoryFilterBar
          categories={presentCategories}
          active={effectiveCategory}
          onSelect={setActiveCategory}
        />
      )}
      {notifications.length > 1 && (
        <div className="flex items-center gap-2 px-3 py-1.5">
          <span className="text-2xs font-medium uppercase tracking-wide text-white/60">
            Sort
          </span>
          <div className="ml-auto flex items-center gap-0.5 rounded-md bg-white/10 p-0.5">
            {(
              [
                ["priority", "Priority"],
                ["time", "Recent"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                data-testid={`notif-sort-${mode}`}
                aria-pressed={sortMode === mode}
                onClick={() => setSortMode(mode)}
                className={cn(
                  "rounded-sm px-2 py-0.5 text-2xs font-medium transition-colors",
                  sortMode === mode
                    ? "bg-accent/15 text-accent"
                    : "text-white/60 hover:text-white",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {notifications.length === 0 ? (
        <div
          className={cn(
            "flex flex-col items-center justify-center gap-2 px-4 py-12 text-center",
            // Give the controlled shells a comfortable floor so an empty
            // overlay is not a razor-thin strip; the bell popover sizes tight.
            isControlled && "min-h-[9rem]",
          )}
        >
          {/* Distinguish "not loaded yet" from "genuinely empty": the store sets
              `hydrated` only once the inbox fetch settles, so before that we show
              a neutral loading line instead of the definitive "all caught up"
              (which would flash then get replaced when rows arrive). */}
          {hydrated ? (
            <>
              <Inbox className="h-7 w-7 text-white/50" />
              <span className="text-sm text-white/70">
                You're all caught up
              </span>
            </>
          ) : (
            <span className="text-sm text-white/70">Loading…</span>
          )}
        </div>
      ) : (
        <ul
          className={cn(
            "flex flex-col gap-1.5 overflow-y-auto p-2",
            // Controlled shells are flex columns capped at a max height, so the
            // list is the flex scroller: it sizes to content but `min-h-0` lets
            // it shrink and scroll when the list overflows, keeping header +
            // close pinned (robust in short landscape). The bell popover is not
            // height-bounded by a parent, so it self-bounds.
            isControlled ? "min-h-0" : "max-h-[min(440px,60vh)]",
          )}
        >
          {visibleNotifications.map((notification) => (
            <NotificationRow
              key={notification.id}
              notification={notification}
              onClose={() =>
                isControlled ? onOpenChange?.(false) : setBellOpen(false)
              }
            />
          ))}
        </ul>
      )}
    </>
  );

  // Mobile pull-down sheet: a full-width, top-anchored panel the home surface
  // reveals with a downward pull (#10706), rounded at the bottom and safe-area
  // aware. Backdrop dismisses; a grabber hints the gesture. In short landscape
  // it caps lower so it floats over the (already short) viewport instead of
  // swallowing it — the list stays the flex scroller.
  if (effectiveVariant === "sheet") {
    if (!open) return null;
    return overlayPortal(
      <>
        <button
          type="button"
          aria-label="Dismiss notifications"
          data-testid="notification-sheet-backdrop"
          data-above-shell-overlay
          // Not a Tab stop: Escape + the labelled Close button cover keyboard
          // dismissal, so the first Tab inside the trapped dialog is a real
          // control, not this invisible catcher.
          tabIndex={-1}
          onClick={() => onOpenChange?.(false)}
          style={{ zIndex: Z_NOTIFICATION_BACKDROP }}
          className="fixed inset-0 bg-black/40"
        />
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Notifications"
          data-testid="notification-sheet"
          data-above-shell-overlay
          tabIndex={-1}
          onKeyDown={onDialogKeyDown}
          style={{ zIndex: Z_NOTIFICATION_OVERLAY }}
          className={cn(
            // iOS-notification-center shell: ONE dark frosted-glass layer over
            // the wallpaper (flat — no drop shadow, app-wide direction); the
            // notification cards float inside it as translucent tiles. Short
            // landscape caps lower so it floats over the (already short) viewport.
            "fixed inset-x-0 top-0 mx-auto flex w-[min(440px,calc(100vw-1rem))] flex-col overflow-hidden rounded-b-2xl border-x border-b border-white/10 bg-black/45 backdrop-blur-2xl outline-none",
            isShortLandscape ? "max-h-[75vh]" : "max-h-[85vh]",
            "pt-[var(--safe-area-top,0px)]",
            className,
          )}
        >
          {panelBody}
          {/* The bottom grabber is a real dismiss control, not a fake drag
              affordance: tapping it (or the pill) closes the sheet. Binding a
              pull-up gesture to the whole sheet would fight the notification
              list's own vertical scroll, so this is a plain click target. */}
          <button
            type="button"
            aria-label="Dismiss notifications"
            data-testid="notification-sheet-grabber"
            onClick={() => onOpenChange?.(false)}
            className="flex shrink-0 justify-center py-2"
          >
            <span className="h-1 w-9 rounded-full bg-white/40" aria-hidden />
          </button>
        </div>
      </>,
    );
  }

  // Desktop / web panel: a native top-RIGHT anchored dropdown (constrained
  // width, content-sized up to a max height then the list scrolls). Opened by
  // the desktop-native "Notifications" menu/tray + the <scheme>://notifications
  // deep link via OPEN_NOTIFICATION_CENTER_EVENT. A transparent full-screen
  // click-catcher dismisses on outside click (no modal scrim — this reads as a
  // panel, not a dialog); Escape also dismisses (effect above).
  if (effectiveVariant === "panel") {
    if (!open) return null;
    return overlayPortal(
      <>
        <button
          type="button"
          aria-label="Dismiss notifications"
          data-testid="notification-panel-backdrop"
          data-above-shell-overlay
          // Not a Tab stop (see the sheet backdrop): the full-screen catcher
          // blocks background pointer interaction but must not be the first
          // keyboard focus target inside the trapped dialog.
          tabIndex={-1}
          onClick={() => onOpenChange?.(false)}
          style={{ zIndex: Z_NOTIFICATION_BACKDROP }}
          className="fixed inset-0"
        />
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Notifications"
          data-testid="notification-panel"
          data-above-shell-overlay
          tabIndex={-1}
          onKeyDown={onDialogKeyDown}
          style={{ zIndex: Z_NOTIFICATION_OVERLAY }}
          className={cn(
            // Same dark frosted-glass treatment as the mobile sheet so the two
            // surfaces can't drift (flat: 1px border, no shadow).
            "fixed right-3 top-3 flex max-h-[min(560px,calc(100vh-1.5rem))] w-[400px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl border border-white/10 bg-black/45 backdrop-blur-2xl outline-none",
            className,
          )}
        >
          {panelBody}
        </div>
      </>,
    );
  }

  return (
    <Popover open={bellOpen} onOpenChange={setBellOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            hasUnread
              ? `Notifications (${unreadCount} unread)`
              : "Notifications"
          }
          className={cn(
            "relative inline-flex h-9 w-9 items-center justify-center rounded-sm text-muted-strong transition-colors hover:bg-surface hover:text-txt",
            className,
          )}
        >
          {hasUnread ? (
            <BellRing className="h-[18px] w-[18px]" />
          ) : (
            <Bell className="h-[18px] w-[18px]" />
          )}
          {hasUnread && (
            /* Unread = one dot; the exact count lives in the aria-label. */
            <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[min(360px,calc(100vw-1.5rem))] p-0"
      >
        {panelBody}
      </PopoverContent>
    </Popover>
  );
}

export default NotificationCenter;
