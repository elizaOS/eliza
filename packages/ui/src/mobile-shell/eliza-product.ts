/**
 * Eliza as a registered product of the mobile shell: the reference record a
 * branded build compares its feature manifest with. Its views are the
 * canonical views Eliza's launcher offers (the everyday apps, then the
 * native-OS tiles of the AOSP build); Eliza views outside the canonical
 * vocabulary (tasks, character, documents, memories, developer surfaces) are
 * not shell views yet. The installed names are the ones Eliza's launcher
 * already writes: `eliza.launcher.favorites.v1` with `eliza:` view keys, and
 * the older `wallet` key migrates to `inventory`.
 */
import { ELIZA_DEFAULT_THEME } from "../config/theme";
import {
  defineMobileProductRegistration,
  type MobileProductRegistration,
} from "./product-registration";

/** Capabilities every product of the shared shell provides through it. */
export const MOBILE_SHELL_LAUNCHER_CAPABILITIES = [
  "launcher.installed-apps",
  "launcher.default-dial",
  "launcher.favorites",
] as const;

export const ELIZA_MOBILE_PRODUCT = defineMobileProductRegistration({
  schema: "elizaos.mobile-product",
  schemaVersion: 1,
  revision: 1,
  identity: {
    appName: "Eliza",
    appId: "ai.elizaos.app",
    characterName: "Eliza",
  },
  theme: {
    ...ELIZA_DEFAULT_THEME,
    defaultAppearance: "system",
    chrome: {
      light: {
        scrim: "rgba(0, 0, 0, 0.32)",
        shadow: "rgba(0, 0, 0, 0.12)",
        frame: "#e9e8e5",
      },
      dark: {
        scrim: "rgba(0, 0, 0, 0.56)",
        shadow: "rgba(0, 0, 0, 0.4)",
        frame: "#1a1a1a",
      },
    },
  },
  icons: {
    // Lucide glyph names, the set Eliza's launcher draws; the prefix is
    // where the mobile entry serves them as single-color SVGs.
    baseUrl: "/icons/lucide/",
    allApps: "layout-grid",
    views: {
      settings: "settings",
      inventory: "wallet",
      calendar: "calendar",
      notes: "sticky-note",
      clock: "clock",
      automations: "workflow",
      browser: "globe",
      phone: "phone",
      messages: "message-square",
      contacts: "user-round",
      camera: "camera",
      files: "folder",
    },
  },
  views: {
    order: [
      "settings",
      "inventory",
      "calendar",
      "notes",
      "clock",
      "automations",
      "browser",
      "phone",
      "messages",
      "contacts",
      "camera",
      "files",
    ],
    labels: {
      settings: "Settings",
      inventory: "Wallet",
      calendar: "Calendar",
      notes: "Notes",
      clock: "Clock",
      automations: "Automations",
      browser: "Browser",
      phone: "Phone",
      messages: "Messages",
      contacts: "Contacts",
      camera: "Camera",
      files: "Files",
    },
    legacyIds: { home: "chat", wallet: "inventory" },
    serves: { calendar: ["reminders"] },
  },
  storage: {
    launcherFavorites: "eliza.launcher.favorites.v1",
    launcherBuiltinPrefix: "eliza:",
    launcherDefaultPolicy: "eliza-apps",
    retained: {},
  },
  features: {
    capabilities: [...MOBILE_SHELL_LAUNCHER_CAPABILITIES],
    actions: [],
  },
} satisfies MobileProductRegistration);
