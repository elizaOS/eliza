import type { CapacitorConfig } from "@capacitor/cli";
import { KeyboardResize, KeyboardStyle } from "@capacitor/keyboard";

const serverUrl = process.env.CAPACITOR_SERVER_URL;

const config: CapacitorConfig = {
  appId: "market.feed.app",
  appName: "Feed",
  webDir: "out",
  server: {
    ...(serverUrl ? { url: serverUrl, cleartext: true } : {}),
    androidScheme: "https",
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 2000,
      backgroundColor: "#0a0a0a",
      showSpinner: false,
      androidScaleType: "CENTER_CROP",
      splashFullScreen: true,
      splashImmersive: true,
    },
    Keyboard: {
      resize: KeyboardResize.Body,
      style: KeyboardStyle.Dark,
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#0a0a0a",
    },
  },
};

export default config;
