import type { DesktopWorkspaceSnapshot } from "../../utils/desktop-workspace";
type Translator = (key: string, options?: Record<string, unknown>) => string;
export interface DesktopWindowControls {
    show: () => Promise<void>;
    hide: () => Promise<void>;
    focus: () => Promise<void>;
    toggleMinimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    notify: () => Promise<void>;
}
export declare function useDesktopWindowControls(snapshot: DesktopWorkspaceSnapshot | null, t: Translator): DesktopWindowControls;
export {};
//# sourceMappingURL=useDesktopWindowControls.d.ts.map