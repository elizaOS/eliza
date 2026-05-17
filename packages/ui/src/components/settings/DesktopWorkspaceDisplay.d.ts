import { type DesktopWorkspaceSnapshot } from "../../utils/desktop-workspace";
type Translator = (key: string, options?: Record<string, unknown>) => string;
export declare function useDesktopDiagnosticsText(snapshot: DesktopWorkspaceSnapshot | null, t: Translator): string;
export declare function DesktopWorkspaceDisplay({ diagnosticsText, t, }: {
    diagnosticsText: string;
    t: Translator;
}): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=DesktopWorkspaceDisplay.d.ts.map