/** Metadata-only app-window routing; page bundles load only when selected. */
import {
  type AppShellPageRegistration,
  listAppShellPages,
} from "../../app-shell-registry";
import type { Tab } from "../../navigation";
import {
  getInternalToolAppDescriptors,
  getInternalToolAppTargetTab,
} from "./internal-tool-apps";

export type DeclaredAppWindowRoute =
  | { kind: "internal"; tab: Tab }
  | { kind: "page"; page: AppShellPageRegistration };

export function resolveDeclaredAppWindowRoute(
  slug: string,
): DeclaredAppWindowRoute | null {
  const path = `/apps/${slug}`;
  const internal = getInternalToolAppDescriptors().find(
    (entry) => entry.windowPath === path,
  );
  const tab = internal ? getInternalToolAppTargetTab(internal.name) : null;
  if (tab) return { kind: "internal", tab };
  const page = listAppShellPages().find(
    (entry) =>
      entry.path === path ||
      (entry.path.startsWith("/apps/") &&
        entry.path.slice("/apps/".length).split("/")[0] === slug),
  );
  return page ? { kind: "page", page } : null;
}
