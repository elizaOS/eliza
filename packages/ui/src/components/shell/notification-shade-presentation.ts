/**
 * Computes and applies the notification shade's live pull presentation.
 * Pointer-frame style writes stay outside React so dragging many notification
 * groups remains smooth while React remains authoritative for settled states.
 */
import type { CSSProperties } from "react";
import { sqrtRubberBand } from "../../gestures/recognizers";

/** Full visual travel between the shade's rested and expanded detents. */
export const PULL_TRAVEL_PX = 88;

/** A slow drag commits at the same halfway point as the home pager. */
export const PULL_COMMIT_PX = PULL_TRAVEL_PX / 2;

/** Dead zone before a vertical drag starts reading as a pull. */
export const PULL_SLOP_PX = 8;

/** Extreme pulls retain elastic give without moving cards beyond the shade. */
const PULL_MAX_OVERSHOOT_PX = 32;

/** Track the finger directly between detents, resisting only past the end. */
export function dampenPull(rawDy: number): number {
  const travel = Math.max(0, rawDy - PULL_SLOP_PX);
  if (travel <= PULL_TRAVEL_PX) return travel;
  const overshoot = sqrtRubberBand(travel - PULL_TRAVEL_PX, 1.85);
  return PULL_TRAVEL_PX + Math.min(PULL_MAX_OVERSHOOT_PX, overshoot);
}

/** Preserve the resisted travel past either detent as visible elastic give. */
export function notificationPullOvershootOffset(pullPx: number): number {
  const overshoot = Math.max(0, Math.abs(pullPx) - PULL_TRAVEL_PX);
  return Math.sign(pullPx) * overshoot;
}

/** Convert live pull travel into a staggered reveal for hidden groups. */
export function notificationPullRevealProgress(
  pullPx: number,
  groupIndex: number,
): number {
  const progress = Math.min(1, Math.max(0, pullPx / PULL_TRAVEL_PX));
  const stagger = Math.min(Math.max(groupIndex, 0), 4) * 0.06;
  return Math.min(1, Math.max(0, (progress - stagger) / (1 - stagger)));
}

export function notificationPullRevealStyle(
  progress: number,
  offsetPx = 0,
): CSSProperties {
  return {
    opacity: progress,
    transform: `translate3d(0, ${(1 - progress) * -8 + offsetPx}px, 0)`,
  };
}

export function notificationPullPresentation(
  pullPx: number,
  shadeExpanded: boolean,
  shadeClosing: boolean,
) {
  const dragCloseProgress =
    shadeExpanded && !shadeClosing
      ? notificationPullRevealProgress(-pullPx, 0)
      : 0;
  const committedCloseProgress = shadeClosing ? 1 : 0;
  const shadeCloseProgress = Math.max(
    dragCloseProgress,
    committedCloseProgress,
  );
  const disposableContentVisibility = 1 - shadeCloseProgress;
  const pullRevealProgress = notificationPullRevealProgress(pullPx, 0);
  const pullContentVisibility = shadeExpanded
    ? disposableContentVisibility
    : pullRevealProgress;
  const pullOvershootOffset = notificationPullOvershootOffset(pullPx);
  const countCloseOvershootProgress = Math.min(
    1,
    Math.max(0, -pullOvershootOffset / (PULL_MAX_OVERSHOOT_PX / 4)),
  );
  const countCloseBoundaryVisibility =
    1 -
    countCloseOvershootProgress ** 2 * (3 - 2 * countCloseOvershootProgress);
  // The count follows the same continuous travel as the cards but stays much
  // dimmer while their surfaces overlap. This reads as a fade beneath the
  // stack without either legible text through glass or a hard clipping edge.
  // Once upward elastic travel carries it toward the scrollport boundary, a
  // smooth end fade completes before the final quarter of resisted movement.
  const notificationCountVisibility =
    (shadeExpanded ? shadeCloseProgress ** 3 : (1 - pullRevealProgress) ** 3) *
    countCloseBoundaryVisibility;
  const clearControlVisibility = shadeExpanded
    ? disposableContentVisibility
    : pullPx > 0
      ? pullRevealProgress
      : 0;
  // The clear-control slot reserves its full row as soon as a drag starts so
  // notification groups can mount without reflowing under the finger. The
  // count follows that slot in document flow, so it needs the same inverse
  // offset as the groups or its first drag frame jumps by the full 40px row.
  const notificationCountOffset = notificationGroupContainerOffset(
    pullPx,
    shadeExpanded,
    shadeClosing,
  );
  return {
    shadeCloseProgress,
    committedCloseProgress,
    disposableContentVisibility,
    pullContentVisibility,
    notificationCountVisibility,
    notificationCountOffset,
    pullOvershootOffset,
    collapseControlOvershootOffset: Math.min(0, pullOvershootOffset),
    notificationCountLayoutVisibility:
      shadeExpanded && pullPx < 0 && !shadeClosing
        ? 1
        : shadeExpanded
          ? shadeCloseProgress
          : 1 - pullRevealProgress,
    emptyStateVisibility: shadeExpanded
      ? disposableContentVisibility
      : notificationPullRevealProgress(pullPx, 0),
    collapseControlVisibility: shadeExpanded
      ? disposableContentVisibility
      : pullRevealProgress,
    clearControlVisibility,
    clearControlLayoutVisibility: shadeExpanded
      ? shadeClosing || pullPx < 0
        ? 0
        : 1
      : pullPx > 0
        ? 1
        : 0,
  };
}

export function notificationGroupContainerOffset(
  pullPx: number,
  shadeExpanded: boolean,
  shadeClosing: boolean,
): number {
  if (shadeClosing) return 0;
  if (shadeExpanded && pullPx < 0) {
    return (1 - notificationPullRevealProgress(-pullPx, 0)) * 40;
  }
  if (!shadeExpanded && pullPx > 0) {
    return (1 - notificationPullRevealProgress(pullPx, 0)) * -40;
  }
  return 0;
}

export function notificationGroupPullOffset(
  pullPx: number,
  shadeExpanded: boolean,
  shadeClosing: boolean,
  groupVisibility: number,
): number {
  const countSlotCompensation =
    shadeExpanded && pullPx < 0 && !shadeClosing
      ? (1 - notificationPullRevealProgress(-pullPx, 0)) * -40
      : 0;
  return countSlotCompensation + (1 - groupVisibility) * -8;
}

export function notificationGroupPullVisibility(
  pullPx: number,
  groupIndex: number,
  shadeExpanded: boolean,
  shadeClosing: boolean,
  pullRevealed: boolean,
): number {
  if (pullRevealed) {
    return notificationPullRevealProgress(pullPx, groupIndex);
  }
  if (shadeClosing) return 0;
  if (shadeExpanded && pullPx < 0) {
    return notificationPullRevealProgress(PULL_TRAVEL_PX + pullPx, groupIndex);
  }
  return 1;
}

/**
 * Apply the live pull presentation without rebuilding the notification tree on
 * every pointer move. React remains authoritative for the settled states.
 */
export function applyNotificationPullPresentation(
  root: HTMLElement | null,
  pullPx: number,
  shadeExpanded: boolean,
  shadeClosing: boolean,
  visibleGroups?: readonly HTMLElement[],
): void {
  const count = root?.querySelector<HTMLElement>(
    "[data-notification-count-slot]",
  );
  if (!root) return;
  const presentation = notificationPullPresentation(
    pullPx,
    shadeExpanded,
    shadeClosing,
  );
  const scrollport = root.querySelector<HTMLElement>(
    "[data-testid='home-notification-list']",
  );
  scrollport?.style.setProperty(
    "--eliza-notif-pull-overshoot",
    `${Math.max(0, presentation.pullOvershootOffset)}px`,
  );
  if (count) {
    count.style.height = `${presentation.notificationCountLayoutVisibility * 32}px`;
    count.style.marginBottom = `${(presentation.notificationCountLayoutVisibility - 1) * 8}px`;
    count.style.opacity = String(presentation.notificationCountVisibility);
    count.style.transform = `translate3d(0, ${
      presentation.notificationCountOffset + presentation.pullOvershootOffset
    }px, 0)`;
  }
  const clearSlot = root.querySelector<HTMLElement>(
    "[data-notification-clear-slot]",
  );
  if (clearSlot) {
    clearSlot.style.height = `${presentation.clearControlLayoutVisibility * 32}px`;
    clearSlot.style.marginBottom = `${(presentation.clearControlLayoutVisibility - 1) * 8}px`;
    clearSlot.style.opacity = String(presentation.clearControlVisibility);
    clearSlot.style.transform = `translate3d(0, ${
      (1 - presentation.clearControlVisibility) * -8 +
      presentation.pullOvershootOffset
    }px, 0)`;
  }
  const empty = root.querySelector<HTMLElement>("[data-notification-empty]");
  if (empty) {
    Object.assign(
      empty.style,
      notificationPullRevealStyle(
        presentation.emptyStateVisibility,
        presentation.pullOvershootOffset,
      ),
    );
  }
  const collapse = root.querySelector<HTMLElement>(
    "[data-notification-collapse-footer]",
  );
  if (collapse) {
    collapse.style.opacity = String(presentation.collapseControlVisibility);
    collapse.style.transform = `translateY(${
      (1 - presentation.collapseControlVisibility) * 4 +
      presentation.collapseControlOvershootOffset
    }px)`;
  }
  const groups =
    visibleGroups ??
    root.querySelectorAll<HTMLElement>("[data-notification-group]");
  for (const group of groups) {
    const groupIndex = Number(group.dataset.notificationGroupIndex ?? 0);
    const pullRevealed = group.hasAttribute("data-notification-pull-reveal");
    const groupVisibility = notificationGroupPullVisibility(
      pullPx,
      groupIndex,
      shadeExpanded,
      shadeClosing,
      pullRevealed,
    );
    const containerOffset = notificationGroupContainerOffset(
      pullPx,
      shadeExpanded,
      shadeClosing,
    );
    const rested = group.hasAttribute("data-rested-notification-group");
    const content = group.querySelector<HTMLElement>(
      ":scope > [data-notification-group-content]",
    );
    if (content) {
      const contentVisibility = pullRevealed || !rested ? groupVisibility : 1;
      const contentPullOffset = pullRevealed
        ? (1 - groupVisibility) * -8
        : rested
          ? 0
          : notificationGroupPullOffset(
              pullPx,
              shadeExpanded,
              shadeClosing,
              groupVisibility,
            );
      content.style.opacity = String(contentVisibility);
      content.style.transform = `translate3d(0, ${
        containerOffset + contentPullOffset + presentation.pullOvershootOffset
      }px, 0)`;
    }
    if (!shadeExpanded && pullPx > 0) {
      if (content?.hasAttribute("data-notification-stacked")) {
        const restedTailPx = Number(
          content.dataset.notificationRestedTailPx ?? 0,
        );
        const expandedTailPx = Number(
          content.dataset.notificationExpandedTailPx ?? restedTailPx,
        );
        const tailProgress = rested
          ? notificationPullRevealProgress(pullPx, groupIndex)
          : 1;
        const tailPx =
          restedTailPx + (expandedTailPx - restedTailPx) * tailProgress;
        content.style.paddingBottom = `${tailPx}px`;
      }
    }
    const controls = group.querySelector<HTMLElement>(
      "[data-notification-stack-controls]",
    );
    if (controls) {
      controls.style.opacity = String(presentation.disposableContentVisibility);
      controls.style.transform = `translate3d(0, ${(1 - presentation.disposableContentVisibility) * -6}px, 0)`;
    }
    for (const row of group.querySelectorAll<HTMLElement>(
      "[data-notification-disposable-row]",
    )) {
      row.style.opacity = String(presentation.disposableContentVisibility);
      row.style.transform = `translate3d(0, ${(1 - presentation.disposableContentVisibility) * -8}px, 0)`;
    }
    for (const peek of group.querySelectorAll<HTMLElement>(
      "[data-notification-peek-mode]",
    )) {
      const baseOpacity = Number(peek.dataset.notificationPeekBaseOpacity ?? 1);
      const mode = peek.dataset.notificationPeekMode;
      const visibility =
        mode === "close"
          ? presentation.shadeCloseProgress
          : mode === "disposable"
            ? presentation.pullContentVisibility
            : 1;
      peek.style.opacity = String(baseOpacity * visibility);
    }
  }
}

/** Limit direct manipulation to groups near the scrollport. */
export function visibleNotificationGroups(
  root: HTMLElement | null,
  scrollport: HTMLElement | null,
): HTMLElement[] | undefined {
  if (!root || !scrollport) return undefined;
  const viewport = scrollport.getBoundingClientRect();
  const bufferPx = 120;
  return Array.from(
    root.querySelectorAll<HTMLElement>("[data-notification-group]"),
  ).filter((group) => {
    const bounds = group.getBoundingClientRect();
    return (
      bounds.bottom >= viewport.top - bufferPx &&
      bounds.top <= viewport.bottom + bufferPx
    );
  });
}
