/** Unified glass-surface system: tokens, primitive, tier probe, native bridge. */

export {
  GlassStyles,
  GlassSurface,
  type GlassSurfaceProps,
} from "./GlassSurface";
export {
  glassBridge,
  isNativeGlassAvailable,
  type NativeGlassOptions,
  resetGlassBridgeForTests,
} from "./native-bridge";
export {
  GLASS_BANNER_FILL,
  GLASS_CARD_FILL,
  GLASS_MENU_FILL,
  GLASS_PILL_FILL,
  GLASS_RECIPES,
  GLASS_SHEET_FILL,
  type GlassRecipe,
  type GlassVariant,
} from "./tokens";
export { type GlassTier, useNativeGlass } from "./useNativeGlass";
