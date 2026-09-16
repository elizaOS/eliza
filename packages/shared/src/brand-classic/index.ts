/**
 * Eliza Classic brand tokens: asset base path + resolver, canonical colors, and
 * logo references for the Classic variant. Parallel to the default `brand/`
 * tokens; surfaces select one variant at render time.
 */

import { LOGO_FILES } from "../brand/index.js";
import {
  trimEndCharacters,
  trimStartCharacters,
} from "../utils/string-boundaries.js";

export const BRAND_ASSET_BASE_PATH = "/brand" as const;

export function brandAssetPath(
  path: string,
  basePath: string = BRAND_ASSET_BASE_PATH,
) {
  const normalizedBase = trimEndCharacters(basePath, "/");
  const normalizedPath = trimStartCharacters(path, "/");
  return `${normalizedBase}/${normalizedPath}`;
}

export const brandColors = {
  orange: "#FF5800",
  blue: "#0B35F1",
  black: "#000000",
  white: "#FFFFFF",
} as const;

export const brandLogos = {
  elizaOsTextBlack: brandAssetPath(`logos/${LOGO_FILES.osBlack}`),
  elizaOsTextWhite: brandAssetPath(`logos/${LOGO_FILES.osWhite}`),
  elizaLogotext: brandAssetPath(`logos/${LOGO_FILES.elizaLockupWhite}`),
  elizaLogotextBlack: brandAssetPath(`logos/${LOGO_FILES.elizaLockupBlack}`),
  elizaTextBlack: brandAssetPath(`logos/${LOGO_FILES.elizaBlack}`),
  elizaTextWhite: brandAssetPath(`logos/${LOGO_FILES.elizaWhite}`),
  elizaCloudLogotext: brandAssetPath(`logos/${LOGO_FILES.cloudWhite}`),
  elizaCloudLogotextBlack: brandAssetPath(`logos/${LOGO_FILES.cloudBlack}`),
  elizaCloudTextBlack: brandAssetPath(`logos/${LOGO_FILES.cloudTextBlack}`),
  elizaCloudTextWhite: brandAssetPath(`logos/${LOGO_FILES.cloudTextWhite}`),
  elizaOsLogotext: brandAssetPath(`logos/${LOGO_FILES.osLockupWhite}`),
  elizaOsLogotextBlack: brandAssetPath(`logos/${LOGO_FILES.osLockupBlack}`),
  logoBlueBlackBg: brandAssetPath(`logos/${LOGO_FILES.markBlueBlackBg}`),
  logoBlueNoBg: brandAssetPath(`logos/${LOGO_FILES.markBlueNoBg}`),
  logoOrangeBlackBg: brandAssetPath(`logos/${LOGO_FILES.markOrangeBlackBg}`),
  logoOrangeNoBg: brandAssetPath(`logos/${LOGO_FILES.markOrangeNoBg}`),
  logoWhiteBlackBg: brandAssetPath(`logos/${LOGO_FILES.markWhiteBlackBg}`),
  logoWhiteBlueBg: brandAssetPath(`logos/${LOGO_FILES.markWhiteBlueBg}`),
  logoWhiteGrayBg: brandAssetPath(`logos/${LOGO_FILES.markWhiteGrayBg}`),
  logoWhiteNoBg: brandAssetPath(`logos/${LOGO_FILES.markWhiteNoBg}`),
  logoWhiteOrangeBg: brandAssetPath(`logos/${LOGO_FILES.markWhiteOrangeBg}`),
} as const;

export const brandFavicons = {
  ico: "/brand/favicons/favicon.ico",
  svg: "/brand/favicons/favicon.svg",
  png16: "/brand/favicons/favicon-16x16.png",
  png32: "/brand/favicons/favicon-32x32.png",
  appleTouchIcon: "/brand/favicons/apple-touch-icon.png",
  androidChrome192: "/brand/favicons/android-chrome-192x192.png",
  androidChrome512: "/brand/favicons/android-chrome-512x512.png",
} as const;

// The sized renditions synced from packages/shared/assets/concepts/; the
// unsized originals existed only in the retired eliza-archive overlay.
export const brandConcepts = {
  billboard: "/brand/concepts/billboard_concept_1200.jpg",
  chibiUsb: "/brand/concepts/chibi_usb_concept_900.jpg",
  miniPc: "/brand/concepts/concept_minipc_900.jpg",
  phone: "/brand/concepts/concept_phone_800.jpg",
  usbDrive: "/brand/concepts/concept_usbdrive_900.jpg",
} as const;

// The full-quality loop sources shipped only in the retired eliza-archive
// overlay (#16290); the poster and the optimized renditions remain.
export const brandCloudBackgrounds = {
  poster: "/brand/background/clouds_background.jpg",
  optimized: {
    clouds1x360pMp4: "/brand/background/optimized/clouds_1x_360p.mp4",
    clouds1x360pWebm: "/brand/background/optimized/clouds_1x_360p.webm",
    clouds1x480pMp4: "/brand/background/optimized/clouds_1x_480p.mp4",
    clouds1x480pWebm: "/brand/background/optimized/clouds_1x_480p.webm",
    clouds1x720pMp4: "/brand/background/optimized/clouds_1x_720p.mp4",
    clouds1x720pWebm: "/brand/background/optimized/clouds_1x_720p.webm",
    clouds1x1080pMp4: "/brand/background/optimized/clouds_1x_1080p.mp4",
    clouds1x1080pWebm: "/brand/background/optimized/clouds_1x_1080p.webm",
    clouds4x360pMp4: "/brand/background/optimized/clouds_4x_360p.mp4",
    clouds4x360pWebm: "/brand/background/optimized/clouds_4x_360p.webm",
    clouds4x480pMp4: "/brand/background/optimized/clouds_4x_480p.mp4",
    clouds4x480pWebm: "/brand/background/optimized/clouds_4x_480p.webm",
    clouds4x720pMp4: "/brand/background/optimized/clouds_4x_720p.mp4",
    clouds4x720pWebm: "/brand/background/optimized/clouds_4x_720p.webm",
    clouds4x1080pMp4: "/brand/background/optimized/clouds_4x_1080p.mp4",
    clouds4x1080pWebm: "/brand/background/optimized/clouds_4x_1080p.webm",
    clouds8x360pMp4: "/brand/background/optimized/clouds_8x_360p.mp4",
    clouds8x360pWebm: "/brand/background/optimized/clouds_8x_360p.webm",
    clouds8x480pMp4: "/brand/background/optimized/clouds_8x_480p.mp4",
    clouds8x480pWebm: "/brand/background/optimized/clouds_8x_480p.webm",
    clouds8x720pMp4: "/brand/background/optimized/clouds_8x_720p.mp4",
    clouds8x720pWebm: "/brand/background/optimized/clouds_8x_720p.webm",
    clouds8x1080pMp4: "/brand/background/optimized/clouds_8x_1080p.mp4",
    clouds8x1080pWebm: "/brand/background/optimized/clouds_8x_1080p.webm",
  },
} as const;

export const brandAssets = {
  basePath: BRAND_ASSET_BASE_PATH,
  colors: brandColors,
  logos: brandLogos,
  favicons: brandFavicons,
  concepts: brandConcepts,
  cloudBackgrounds: brandCloudBackgrounds,
} as const;
