export const BRAND_ASSET_BASE_PATH = "/brand" as const;

export function brandAssetPath(path: string, basePath = BRAND_ASSET_BASE_PATH) {
  const normalizedBase = basePath.replace(/\/+$/, "");
  const normalizedPath = path.replace(/^\/+/, "");
  return `${normalizedBase}/${normalizedPath}`;
}

export const brandColors = {
  orange: "#FF5800",
  blue: "#0B35F1",
  black: "#000000",
  white: "#FFFFFF",
} as const;

export const brandLogos = {
  elizaOsTextBlack: "/brand/logos/elizaOS_text_black.svg",
  elizaOsTextWhite: "/brand/logos/elizaOS_text_white.svg",
  elizaLogotext: "/brand/logos/eliza_logotext.svg",
  elizaLogotextBlack: "/brand/logos/eliza_logotext_black.svg",
  elizaTextBlack: "/brand/logos/eliza_text_black.svg",
  elizaTextWhite: "/brand/logos/eliza_text_white.svg",
  elizaCloudLogotext: "/brand/logos/elizacloud_logotext.svg",
  elizaCloudLogotextBlack: "/brand/logos/elizacloud_logotext_black.svg",
  elizaCloudTextBlack: "/brand/logos/elizacloud_text_black.svg",
  elizaCloudTextWhite: "/brand/logos/elizacloud_text_white.svg",
  elizaOsLogotext: "/brand/logos/elizaos_logotext.svg",
  elizaOsLogotextBlack: "/brand/logos/elizaos_logotext_black.svg",
  logoBlueBlackBg: "/brand/logos/logo_blue_blackbg.svg",
  logoBlueNoBg: "/brand/logos/logo_blue_nobg.svg",
  logoOrangeBlackBg: "/brand/logos/logo_orange_blackbg.svg",
  logoOrangeNoBg: "/brand/logos/logo_orange_nobg.svg",
  logoWhiteBlackBg: "/brand/logos/logo_white_blackbg.svg",
  logoWhiteBlueBg: "/brand/logos/logo_white_bluebg.svg",
  logoWhiteGrayBg: "/brand/logos/logo_white_graybg.svg",
  logoWhiteNoBg: "/brand/logos/logo_white_nobg.svg",
  logoWhiteOrangeBg: "/brand/logos/logo_white_orangebg.svg",
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

export const brandConcepts = {
  billboard: "/brand/concepts/billboard_concept.jpg",
  chibiUsb: "/brand/concepts/chibi_usb_concept.jpg",
  miniPc: "/brand/concepts/concept_minipc.jpg",
  phone: "/brand/concepts/concept_phone.jpg",
  usbDrive: "/brand/concepts/concept_usbdrive.jpg",
} as const;

export const brandCloudBackgrounds = {
  poster: "/brand/background/clouds_background.jpg",
  sourceMp4: "/brand/background/Clouds_Loop_HQ_1080p.mp4",
  sourceMobileMp4: "/brand/background/Clouds_Loop_Mobile_480p.mp4",
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
