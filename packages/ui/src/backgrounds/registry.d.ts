import type { BackgroundModule } from "./types";
export declare function registerBackground(module: BackgroundModule): void;
export declare function getActiveBackground(): BackgroundModule | undefined;
export declare function setActiveBackground(id: string): BackgroundModule | undefined;
export declare function getBackground(id: string): BackgroundModule | undefined;
export declare function listBackgrounds(): readonly BackgroundModule[];
export declare function getBackgroundHistory(): readonly BackgroundModule[];
export declare function revertBackground(): BackgroundModule | undefined;
export declare function resetBackgroundRegistry(): void;
//# sourceMappingURL=registry.d.ts.map