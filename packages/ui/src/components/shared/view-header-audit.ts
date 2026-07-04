/**
 * Uniform-top-bar audit (#13586, #13451 acceptance).
 *
 * The redesign doctrine requires every `normal` view to render the shared
 * `ViewHeader` (icon-only back + centered title). Views that own their full
 * window (`fullscreen`/`modal`/`immersive`) opt out via their `headerPolicy`.
 *
 * These helpers are the single source of truth for that rule so both unit
 * tests and the real-app e2e soak (`audit:app`) enforce it identically:
 *  - `viewRequiresSharedHeader` decides, from a view's declared `headerPolicy`,
 *    whether the shared header is mandatory.
 *  - `hasSharedViewHeader` detects the rendered header in a DOM subtree by its
 *    stable `data-testid="view-header"` marker.
 *  - `assertSharedViewHeader` throws a descriptive error when a `normal` view's
 *    rendered subtree is missing the header — the audit assertion the issue
 *    asks for (fails on a synthetic headerless `normal` view).
 */

import type { ViewHeaderPolicy } from "@elizaos/core";

/** Stable marker the shared `ViewHeader` renders (see ViewHeader.tsx). */
export const VIEW_HEADER_TESTID = "view-header";

/**
 * The default framing policy for any view that does not declare one. Built-in
 * `normal` views inherit this so the shell enforces the shared header on them.
 */
export const DEFAULT_VIEW_HEADER_POLICY: ViewHeaderPolicy = "normal";

/**
 * True when a view must render the shared `ViewHeader`. Only `normal` views
 * (the default) are required; `fullscreen`/`modal`/`immersive` own their own
 * chrome and are exempt.
 */
export function viewRequiresSharedHeader(
  headerPolicy: ViewHeaderPolicy | undefined,
): boolean {
  return (headerPolicy ?? DEFAULT_VIEW_HEADER_POLICY) === "normal";
}

/** True when `root` contains a rendered shared `ViewHeader`. */
export function hasSharedViewHeader(
  root: ParentNode | null | undefined,
): boolean {
  if (!root) return false;
  return root.querySelector(`[data-testid="${VIEW_HEADER_TESTID}"]`) !== null;
}

/**
 * The audit assertion: throws when a view that {@link viewRequiresSharedHeader}
 * lacks a rendered {@link hasSharedViewHeader} shared header. A no-op for exempt
 * (`fullscreen`/`modal`/`immersive`) views. `viewId` names the offender.
 */
export function assertSharedViewHeader({
  viewId,
  headerPolicy,
  root,
}: {
  viewId: string;
  headerPolicy: ViewHeaderPolicy | undefined;
  root: ParentNode | null | undefined;
}): void {
  if (!viewRequiresSharedHeader(headerPolicy)) return;
  if (hasSharedViewHeader(root)) return;
  throw new Error(
    `Uniform top-bar audit failed: normal view "${viewId}" does not render the ` +
      `shared ViewHeader (no [data-testid="${VIEW_HEADER_TESTID}"] in its ` +
      `subtree). Render <ViewHeader /> or declare a non-normal headerPolicy.`,
  );
}
