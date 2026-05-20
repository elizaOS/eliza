type NavigatorLike = {
  maxTouchPoints?: number;
  platform?: string;
  userAgent?: string;
};

export type DeviceDetection = {
  isAndroid: boolean;
  isFirefox: boolean;
  isIOS: boolean;
  isMobile: boolean;
  isSafari: boolean;
};

const IOS_USER_AGENT_PATTERN = /iphone|ipad|ipod/;
const ANDROID_USER_AGENT_PATTERN = /android/;
const FIREFOX_USER_AGENT_PATTERN = /firefox|fxios/;
const MOBILE_USER_AGENT_PATTERN =
  /android|iphone|ipad|ipod|iemobile|opera mini|mobile/;
const SAFARI_USER_AGENT_PATTERN = /safari/;
const NON_SAFARI_USER_AGENT_PATTERN =
  /android|crios|chrome|chromium|edg|firefox|fxios|opr\//;

function isIPadOnDesktopPlatform(navigatorLike?: NavigatorLike): boolean {
  if (!navigatorLike) return false;

  return (
    navigatorLike.platform === "MacIntel" &&
    (navigatorLike.maxTouchPoints ?? 0) > 1
  );
}

export function detectDevice(navigatorLike?: NavigatorLike): DeviceDetection {
  const userAgent = navigatorLike?.userAgent?.toLowerCase() ?? "";
  const isIOS =
    IOS_USER_AGENT_PATTERN.test(userAgent) ||
    isIPadOnDesktopPlatform(navigatorLike);
  const isAndroid = ANDROID_USER_AGENT_PATTERN.test(userAgent);
  const isFirefox = FIREFOX_USER_AGENT_PATTERN.test(userAgent);
  const isSafari =
    SAFARI_USER_AGENT_PATTERN.test(userAgent) &&
    !NON_SAFARI_USER_AGENT_PATTERN.test(userAgent);
  const isMobile =
    isIOS || isAndroid || MOBILE_USER_AGENT_PATTERN.test(userAgent);

  return {
    isAndroid,
    isFirefox,
    isIOS,
    isMobile,
    isSafari,
  };
}

const detectedDevice = detectDevice(
  typeof navigator === "undefined"
    ? undefined
    : {
        maxTouchPoints: navigator.maxTouchPoints,
        platform: navigator.platform,
        userAgent: navigator.userAgent,
      },
);

export const isAndroid = detectedDevice.isAndroid;
export const isFirefox = detectedDevice.isFirefox;
export const isIOS = detectedDevice.isIOS;
export const isMobile = detectedDevice.isMobile;
export const isSafari = detectedDevice.isSafari;
