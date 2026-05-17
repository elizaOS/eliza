import type { RegistryAppInfo } from "../../api";
import type { Tab } from "../../navigation";
export declare function getInternalToolApps(): RegistryAppInfo[];
export declare function isInternalToolApp(name: string): boolean;
export declare function getInternalToolAppTargetTab(name: string): Tab | null;
export declare function getInternalToolAppCatalogOrder(name: string): number;
export declare function getInternalToolAppWindowPath(name: string): string | null;
export declare function getInternalToolAppHasDetailsPage(name: string): boolean;
/** Plain descriptor used by the desktop application/tray menus. */
export interface InternalToolAppDescriptor {
    readonly name: string;
    readonly displayName: string;
    readonly windowPath: string | null;
    readonly hasDetailsPage: boolean;
    readonly order: number;
}
export declare function getInternalToolAppDescriptors(): readonly InternalToolAppDescriptor[];
//# sourceMappingURL=internal-tool-apps.d.ts.map