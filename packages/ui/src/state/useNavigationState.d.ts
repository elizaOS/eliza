/**
 * Navigation state — extracted from AppContext.
 *
 * Owns: setTab wrappers, switchShellView, switchUiShellMode, setUiShellMode,
 * tab commit effects, uiShellMode persist, lastNativeTab persist,
 * tabFromPath logic, and the NavigationEventHub.
 */
import { type Tab } from "../navigation";
import {
  type ShellView,
  type TabCommittedDetail,
  type UiShellMode,
} from "./internal";
export interface NavigationStateDeps {
  tab: Tab;
  setTabRaw: (t: Tab) => void;
  uiShellMode: UiShellMode;
  hasActiveGameRun: boolean;
  setAppsSubTab: (value: "browse" | "running" | "games") => void;
}
export declare function useNavigationState(deps: NavigationStateDeps): {
  lastNativeTab: Tab;
  setLastNativeTabState: import("react").Dispatch<
    import("react").SetStateAction<Tab>
  >;
  setTab: (newTab: Tab) => void;
  setUiShellMode: (mode: UiShellMode) => void;
  switchUiShellMode: (mode: UiShellMode) => void;
  switchShellView: (view: ShellView) => void;
  navigation: {
    subscribeTabCommitted: (
      listener: (detail: TabCommittedDetail) => void,
    ) => () => void;
    scheduleAfterTabCommit: (fn: () => void) => void;
  };
};
//# sourceMappingURL=useNavigationState.d.ts.map
