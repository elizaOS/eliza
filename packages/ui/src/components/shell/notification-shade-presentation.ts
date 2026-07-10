/**
 * Computes and applies the notification shade's live pull presentation.
 * Pointer-frame style writes stay outside React so dragging many notification
 * groups remains smooth while React remains authoritative for settled states.
 */
import type { CSSProperties } from "react";

/** Dampened pull travel that commits a shade mode change on release. */
export const PULL_COMMIT_PX = 48;

/** Dead zone before a vertical drag starts reading as a pull. */
export const PULL_SLOP_PX = 8;

/** Rubber-band raw overscroll into the travel rendered by the shade. */
export function dampenPull(rawDy: number): number {
  return Math.min(Math.max(0, rawDy - PULL_SLOP_PX) * 0.5, 88);
}

/** Convert live pull travel into a staggered reveal for hidden groups. */
export function notificationPullRevealProgress(
  pullPx: number,
  groupIndex: number,
): number {
  const progress = Math.min(1, Math.max(0, pullPx / PULL_COMMIT_PX));
  const stagger = Math.min(Math.max(groupIndex, 0), 4) * 0.06;
  return Math.min(1, Math.max(0, (progress - stagger) / (1 - stagger)));
}

export function notificationPullRevealStyle(progress: number): CSSProperties {
  return {
    opacity: progress,
    transform: `translate3d(0, ${(1 - progress) * -8}px, 0)`,
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
  const pullContentVisibility = shadeExpanded
    ? disposableContentVisibility
    : notificationPullRevealProgress(pullPx, 0);
  const notificationCountVisibility = shadeExpanded
    ? shadeCloseProgress
    : 1 - notificationPullRevealProgress(pullPx, 0);
  const clearControlVisibility = shadeExpanded
    ? disposableContentVisibility
    : pullPx > 0
      ? notificationPullRevealProgress(pullPx, 0)
      : 0;

  return {
    shadeCloseProgress,
    committedCloseProgress,
    disposableContentVisibility,
    pullContentVisibility,
    notificationCountVisibility,
    notificationCountLayoutVisibility:
      shadeExpanded && pullPx < 0 && !shadeClosing
        ? 1
        : notificationCountVisibility,
    emptyStateVisibility: shadeExpanded
      ? disposableContentVisibility
      : notificationPullRevealProgress(pullPx, 0),
    collapseControlVisibility: shadeExpanded
      ? disposableContentVisibility
      : notificationPullRevealProgress(pullPx, 0),
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
    return notificationPullRevealProgress(PULL_COMMIT_PX + pullPx, groupIndex);
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
  if (!root) return;
  const presentation = notificationPullPresentation(
    pullPx,
    shadeExpanded,
    shadeClosing,
  );
  const count = root.querySelector<HTMLElement>(
    "[data-notification-count-slot]",
  );
  if (count) {
    count.style.height = `${presentation.notificationCountLayoutVisibility * 32}px`;
    count.style.marginBottom = `${(presentation.notificationCountLayoutVisibility - 1) * 8}px`;
    count.style.opacity = String(presentation.notificationCountVisibility);
  }
  const clearSlot = root.querySelector<HTMLElement>(
    "[data-notification-clear-slot]",
  );
  if (clearSlot) {
    clearSlot.style.height = `${presentation.clearControlLayoutVisibility * 32}px`;
    clearSlot.style.marginBottom = `${(presentation.clearControlLayoutVisibility - 1) * 8}px`;
    clearSlot.style.opacity = String(presentation.clearControlVisibility);
    clearSlot.style.transform = `translate3d(0, ${(1 - presentation.clearControlVisibility) * -8}px, 0)`;
  }
  const empty = root.querySelector<HTMLElement>("[data-notification-empty]");
  if (empty) {
    Object.assign(
      empty.style,
      notificationPullRevealStyle(presentation.emptyStateVisibility),
    );
  }
  const collapse = root.querySelector<HTMLElement>(
    "[data-notification-collapse-footer]",
  );
  if (collapse) {
    collapse.style.opacity = String(presentation.collapseControlVisibility);
    collapse.style.transform = `translateY(${(1 - presentation.collapseControlVisibility) * 4}px)`;
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
    group.style.transform = `translate3d(0, ${
      containerOffset + (pullRevealed ? (1 - groupVisibility) * -8 : 0)
    }px, 0)`;
    if (pullRevealed) group.style.opacity = String(groupVisibility);
    if (
      !pullRevealed &&
      !group.hasAttribute("data-rested-notification-group")
    ) {
      const content = group.querySelector<HTMLElement>(
        ":scope > [data-notification-group-content]",
      );
      if (content) {
        content.style.opacity = String(groupVisibility);
        content.style.transform = `translate3d(0, ${notificationGroupPullOffset(
          pullPx,
          shadeExpanded,
          shadeClosing,
          groupVisibility,
        )}px, 0)`;
      }
    }
    if (!shadeExpanded && pullPx > 0) {
      const content = group.querySelector<HTMLElement>(
        ":scope > [data-notification-group-content][data-notification-stacked]",
      );
      if (content) {
        const restedTailPx = Number(
          content.dataset.notificationRestedTailPx ?? 0,
        );
        const expandedTailPx = Number(
          content.dataset.notificationExpandedTailPx ?? restedTailPx,
        );
        const tailProgress = group.hasAttribute(
          "data-rested-notification-group",
        )
          ? notificationPullRevealProgress(pullPx, groupIndex)
          : 1;
        const tailPx =
          restedTailPx + (expandedTailPx - restedTailPx) * tailProgress;
        content.style.paddingBottom = `${tailPx}px`;
        for (const peek of content.querySelectorAll<HTMLElement>(
          "[data-notification-stack-peek]",
        )) {
          peek.style.bottom = `${tailPx}px`;
        }
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
