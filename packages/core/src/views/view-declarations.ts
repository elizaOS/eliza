/** Collapses host view declarations while preserving their runtime interaction handlers. */
import { type CollapsedView, type ViewDeclaration } from "../types/plugin.js";
import { type ViewModality } from "../types/view-kind.js";

export type {
  CollapsedView,
  ViewDeclaration,
  ViewModality,
} from "@elizaos/core";

import { dedupeModalities } from "@elizaos/core/views/view-kind";

/**
 * The surfaces a view declaration renders on: the explicit `modalities` list
 * when set, otherwise the single `viewType` (default "gui").
 */
export function getViewModalities(
  view: Pick<ViewDeclaration, "modalities" | "viewType">,
): ViewModality[] {
  if (view.modalities && view.modalities.length > 0) {
    return dedupeModalities(view.modalities);
  }
  return [view.viewType ?? "gui"];
}

/**
 * Collapse view declarations to one entry per `id`, unioning the surfaces each
 * declaration supports. The "gui" declaration (clean label, no surface suffix)
 * is preferred as the canonical base. This is the single source the view
 * catalog and modality hosts use so a view appears once with modality badges
 * instead of one duplicate row per future surface variant.
 */
export function collapseViewDeclarations(
  views: readonly ViewDeclaration[],
): CollapsedView[] {
  const order: string[] = [];
  const byId = new Map<string, CollapsedView>();
  for (const view of views) {
    const mods = getViewModalities(view);
    const existing = byId.get(view.id);
    if (!existing) {
      order.push(view.id);
      byId.set(view.id, { ...view, modalities: mods });
      continue;
    }
    const merged = dedupeModalities([...existing.modalities, ...mods]);
    const isGui = (view.viewType ?? "gui") === "gui";
    const baseWasGui = (existing.viewType ?? "gui") === "gui";
    const base = isGui && !baseWasGui ? view : existing;
    byId.set(view.id, { ...base, modalities: merged });
  }
  return order.map((id) => byId.get(id) as CollapsedView);
}
