/**
 * Resolves which view kinds are enabled for the client: system/release always
 * on, developer/preview following the two Settings toggles.
 */
import {
  type EnabledViewKinds,
  isViewKindEnabled,
  isViewVisible,
  resolveViewKind,
  type ViewKind,
  type ViewKindBearer,
} from "@elizaos/core";
import { useMemo } from "react";
import { useIsDeveloperMode } from "./useDeveloperMode";
import { useIsPreviewMode } from "./usePreviewMode";

/**
 * The client is the authority on which view kinds are enabled: `system` and
 * `release` are always on, while `developer` and `preview` follow the two
 * Settings toggles (whose defaults depend on the build — dev vs production).
 * The server returns every view with its `viewKind`; this hook tells the shell
 * which ones to actually show.
 *
 * Use {@link useEnabledViewKinds} to get the toggle state and pass it to the
 * pure `isViewVisible` / `isViewKindEnabled` helpers from `@elizaos/core`.
 */
export function useEnabledViewKinds(): EnabledViewKinds {
  const developer = useIsDeveloperMode();
  const preview = useIsPreviewMode();
  return useMemo(() => ({ developer, preview }), [developer, preview]);
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
