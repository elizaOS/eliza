/**
 * Build variant accessor for the renderer.
 *
 * The variant is baked into the bundle at Vite build time via the
 * `__MILADY_BUILD_VARIANT__` define (see `packages/app/vite.config.ts`).
 * Mirror of `packages/app-core/src/runtime/build-variant.ts` for the
 * Node/Bun side — kept as a separate module because the source surface
 * differs (Vite define vs `process.env`).
 */

declare const __MILADY_BUILD_VARIANT__: string | undefined;

export const BUILD_VARIANTS = ["store", "direct"] as const;
export type BuildVariant = (typeof BUILD_VARIANTS)[number];

export const DEFAULT_BUILD_VARIANT: BuildVariant = "direct";

function readDefine(): string | undefined {
  if (typeof __MILADY_BUILD_VARIANT__ === "string") {
    return __MILADY_BUILD_VARIANT__;
  }
  return undefined;
}

export function getBuildVariant(): BuildVariant {
  const raw = readDefine();
  if (raw === "store") return "store";
  if (raw === "direct") return "direct";
  return DEFAULT_BUILD_VARIANT;
}

export function isStoreBuild(): boolean {
  return getBuildVariant() === "store";
}

export function isDirectBuild(): boolean {
  return getBuildVariant() === "direct";
}
