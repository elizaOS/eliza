import type { AvatarModule } from "./types";
export declare function registerAvatar(module: AvatarModule): void;
export declare function getActiveAvatar(): AvatarModule | undefined;
export declare function getAvatar(id: string): AvatarModule | undefined;
export declare function setActiveAvatar(id: string): AvatarModule | undefined;
export declare function listAvatars(): readonly AvatarModule[];
export declare function getAvatarHistory(): readonly AvatarModule[];
export declare function revertAvatar(): AvatarModule | undefined;
export declare function resetAvatarRegistry(): void;
//# sourceMappingURL=registry.d.ts.map
