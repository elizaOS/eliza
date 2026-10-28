/**
 * All apps over Home: the shared installed-app inventory with the product's
 * own views listed beside installed apps. Product views draw their glyph from
 * the product icon set; installed apps keep their platform icon.
 */
import { appKey } from "@elizaos/capacitor-system/launcher";
import type { CSSProperties } from "react";
import { InstalledAppsLauncher } from "../components/pages/InstalledAppsLauncher";
import type { MobileShellPartProps } from "./MobileHomeScreen";
import type { MobileShellLauncher } from "./mobile-launcher";
import type { MobileViewRegistry } from "./view-registry";

export interface MobileAllAppsDrawerProps extends MobileShellPartProps {
  shellLauncher: MobileShellLauncher;
  registry: MobileViewRegistry;
  query: string;
  onQuery: (query: string) => void;
  onClose: () => void;
  /** Style of the inventory inside the drawer (launcher properties included). */
  inventoryStyle?: CSSProperties;
}

export function MobileAllAppsDrawer({
  shellLauncher,
  registry,
  query,
  onQuery,
  onClose,
  inventoryStyle,
  style,
  ...attributes
}: MobileAllAppsDrawerProps) {
  const { product } = registry;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="All apps"
      {...attributes}
      data-mobile-shell-drawer=""
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
        background: "var(--bg)",
        color: "var(--text)",
        ...style,
      }}
    >
      <InstalledAppsLauncher
        launcher={shellLauncher.launcher}
        query={query}
        onQuery={onQuery}
        onClose={onClose}
        productName={product.identity.appName}
        builtinPrefix={product.storage.launcherBuiltinPrefix}
        style={
          {
            flex: 1,
            "--launcher-background": "var(--bg)",
            "--launcher-foreground": "var(--text)",
            "--launcher-muted": "var(--muted)",
            "--launcher-surface": "var(--surface)",
            "--launcher-title-font": "var(--font-display, inherit)",
            ...inventoryStyle,
          } as CSSProperties
        }
        renderIcon={(app) => {
          const view = registry.fromLauncherKey(appKey(app));
          const url = view && registry.iconUrl(view);
          if (!url) return undefined;
          const mask = `url("${url}") center / contain no-repeat`;
          return (
            <span
              aria-hidden="true"
              style={{
                display: "block",
                width: 24,
                height: 24,
                backgroundColor: "currentColor",
                mask,
                WebkitMask: mask,
              }}
            />
          );
        }}
      />
    </div>
  );
}
