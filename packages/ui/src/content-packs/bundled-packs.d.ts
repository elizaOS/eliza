/**
 * Bundled content packs derived from the existing character presets.
 *
 * Each of the 8 built-in characters (Chen, Jin, Kei, etc.) becomes a
 * content pack with their VRM, background, and personality.
 */
import type { ResolvedContentPack } from "@elizaos/shared";
/**
 * Get all bundled content packs (derived from the 8 built-in characters).
 * Bundled packs use avatarIndex (1-8) to reference existing VRM assets
 * rather than generating custom VRM URLs.
 */
export declare function getBundledContentPacks(): ResolvedContentPack[];
//# sourceMappingURL=bundled-packs.d.ts.map
