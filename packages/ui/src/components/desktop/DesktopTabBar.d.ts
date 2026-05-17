/**
 * DesktopTabBar — horizontal native tab bar for the Electrobun desktop shell.
 *
 * Renders pinned and dynamically-opened view tabs above the main content area.
 * Only visible when running inside the Electrobun runtime; returns null on web
 * and mobile.
 *
 * Each tab can be closed (unpinned ephemeral) or pinned (persisted across
 * restarts). A "+" button opens the ViewManagerPage so users can pin more views.
 */
import type { DesktopTab } from "../../hooks/useDesktopTabs";
export interface DesktopTabBarProps {
  tabs: DesktopTab[];
  activeViewId: string | null;
  onTabClick: (viewId: string) => void;
  onTabClose: (viewId: string) => void;
  onOpenViewManager: () => void;
}
/**
 * DesktopTabBar renders only in the Electrobun runtime. On web and mobile
 * `isElectrobunRuntime()` returns false and this component returns null.
 */
export declare function DesktopTabBar({
  tabs,
  activeViewId,
  onTabClick,
  onTabClose,
  onOpenViewManager,
}: DesktopTabBarProps): React.JSX.Element | null;
//# sourceMappingURL=DesktopTabBar.d.ts.map
