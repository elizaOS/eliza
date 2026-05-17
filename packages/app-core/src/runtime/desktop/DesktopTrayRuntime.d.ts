import type { DesktopClickAuditItem } from "@elizaos/ui/utils/desktop-workspace";
interface DesktopTrayMenuItem {
    id: string;
    label?: string;
    type?: "normal" | "separator";
}
export declare const DESKTOP_TRAY_MENU_ITEMS: readonly DesktopTrayMenuItem[];
export declare const DESKTOP_TRAY_CLICK_AUDIT: readonly DesktopClickAuditItem[];
export declare function DesktopTrayRuntime(): null;
export {};
//# sourceMappingURL=DesktopTrayRuntime.d.ts.map