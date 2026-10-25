import { Capacitor } from "@capacitor/core";

export function isNativeMobile(): boolean {
  try {
    const platform = Capacitor.getPlatform();
    return platform === "android" || platform === "ios";
  } catch {
    // error-policy:J4 capability probe — no Capacitor runtime means no native
    // OCR on this platform; the bridge simply stays off.
    return false;
  }
}
