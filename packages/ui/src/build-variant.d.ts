/**
 * Build variant accessor for the renderer.
 *
 * The variant is baked into the bundle at Vite build time via the
 * `__ELIZA_BUILD_VARIANT__` define (see `packages/app/vite.config.ts`).
 * Mirror of `packages/app-core/src/runtime/build-variant.ts` for the
 * Node/Bun side — kept as a separate module because the source surface
 * differs (Vite define vs `process.env`).
 */
export declare const BUILD_VARIANTS: readonly ["store", "direct"];
export type BuildVariant = (typeof BUILD_VARIANTS)[number];
export declare const DEFAULT_BUILD_VARIANT: BuildVariant;
export declare function getBuildVariant(): BuildVariant;
export declare function isStoreBuild(): boolean;
export declare function isDirectBuild(): boolean;
//# sourceMappingURL=build-variant.d.ts.map
