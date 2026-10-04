import type { EnabledViewKinds, ViewKind, ViewKindBearer } from "@elizaos/core";
import {
  isViewKindEnabled,
  isViewVisible,
  resolveViewKind,
} from "@elizaos/core/protocol";
import { useMemo, useSyncExternalStore } from "react";

const defaults: EnabledViewKinds = { developer: false, preview: false };
const storageKeys = {
  developer: "eliza:developerMode",
  preview: "eliza:previewMode",
};

function readKinds(): EnabledViewKinds {
  try {
    return {
      developer: window.localStorage.getItem(storageKeys.developer) === "1",
      preview: window.localStorage.getItem(storageKeys.preview) === "1",
    };
  } catch {
    return defaults;
  }
}

let snapshot = readKinds();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    if (event.key !== null && !Object.values(storageKeys).includes(event.key))
      return;
    const next = readKinds();
    if (
      next.developer === snapshot.developer &&
      next.preview === snapshot.preview
    )
      return;
    snapshot = next;
    for (const listener of listeners) listener();
  });
}

/** System and release views are always visible; developer and preview are opt-in. */
export function useEnabledViewKinds(): EnabledViewKinds {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => defaults,
  );
}

/**
 * Returns a stable predicate that reports whether a view-like declaration is
 * visible under the current toggles. Recomputed only when a toggle flips.
 */
export function useViewKindVisible(): (
  decl: ViewKindBearer | null | undefined,
) => boolean {
  const enabled = useEnabledViewKinds();
  return useMemo(
    () => (decl: ViewKindBearer | null | undefined) =>
      isViewVisible(decl, enabled),
    [enabled],
  );
}

export {
  type EnabledViewKinds,
  isViewKindEnabled,
  isViewVisible,
  resolveViewKind,
  type ViewKind,
  type ViewKindBearer,
};
