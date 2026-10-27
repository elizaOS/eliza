/**
 * Versioned registration of one branded mobile product. The shell, its
 * controllers and views are shared; a product supplies only this record:
 * identity, theme, icons, backgrounds, view order, the older view ids it must
 * migrate, and the installed storage names it must keep reading.
 */
import {
  THEME_CSS_VAR_MAP,
  type ThemeColorSet,
  type ThemeDefinition,
  validateThemeDefinition,
} from "@elizaos/contracts";
import { themeCssVariables } from "../config/theme";
import {
  isMobileShellViewId,
  MOBILE_SHELL_HOME_VIEW_ID,
  type MobileShellViewId,
} from "./view-ids";

export const MOBILE_PRODUCT_SCHEMA = "elizaos.mobile-product";
export const MOBILE_PRODUCT_SCHEMA_VERSION = 1;

export type MobileShellAppearance = "light" | "dark";

/** Shell surfaces that ThemeColorSet does not name. */
export interface MobileShellChromeColors {
  /** Dimming layer behind sheets and dialogs. */
  scrim: string;
  /** Shadow tint of floating controls. */
  shadow: string;
  /** Device frame drawn around a desktop preview. */
  frame: string;
}

export type MobileShellThemeToken =
  | keyof ThemeColorSet
  | keyof MobileShellChromeColors
  | "fontBody"
  | "fontDisplay";

export interface MobileProductTheme extends ThemeDefinition {
  /** Appearance used until the owner chooses one. */
  defaultAppearance: MobileShellAppearance | "system";
  chrome: Record<MobileShellAppearance, MobileShellChromeColors>;
  /**
   * Older product stylesheet properties, each bound to the token it shows.
   * They keep existing styles working while they move to the canonical
   * properties; they are not a second palette.
   */
  aliases?: Readonly<Record<string, MobileShellThemeToken>>;
}

export interface MobileProductIdentity {
  /** Display name; equals the product's app config name. */
  appName: string;
  /** Installed application id; never changes for an installed product. */
  appId: string;
  /** Assistant persona name ("Ask <name>"). */
  characterName: string;
}

export interface MobileProductIcons {
  /** URL prefix of single-color SVG glyphs, drawn as currentColor masks. */
  baseUrl: string;
  /** Glyph of each canonical view. */
  views: Readonly<Partial<Record<MobileShellViewId, string>>>;
  /** Glyph of the All apps entry. */
  allApps: string;
}

export interface MobileProductBackgrounds {
  /** CSS background of Home per appearance; the theme `bg` when absent. */
  home?: Readonly<Partial<Record<MobileShellAppearance, string>>>;
}

export interface MobileProductViews {
  /** Home and All apps order of the product's views. */
  order: readonly MobileShellViewId[];
  /** Product renderer keys and older persisted ids, each mapped once. */
  legacyIds: Readonly<Record<string, MobileShellViewId>>;
  /** Canonical ids a product view also serves, e.g. calendar serves reminders. */
  serves?: Readonly<
    Partial<Record<MobileShellViewId, readonly MobileShellViewId[]>>
  >;
}

export interface MobileProductStorage {
  /** Installed launcher favorites list. */
  launcherFavorites: string;
  /** Prefix of the product's own views in that list, e.g. `eliza:`. */
  launcherBuiltinPrefix: string;
  /** Other installed storage names the product keeps reading. */
  retained: Readonly<Record<string, string>>;
}

export interface MobileProductRegistration {
  schema: typeof MOBILE_PRODUCT_SCHEMA;
  schemaVersion: typeof MOBILE_PRODUCT_SCHEMA_VERSION;
  /** Increment on every published change to the record. */
  revision: number;
  identity: MobileProductIdentity;
  theme: MobileProductTheme;
  icons: MobileProductIcons;
  backgrounds?: MobileProductBackgrounds;
  views: MobileProductViews;
  storage: MobileProductStorage;
}

/** Tokens every shell surface reads, required in both appearances. */
export const MOBILE_SHELL_REQUIRED_COLORS = [
  "bg",
  "surface",
  "bgHover",
  "text",
  "muted",
  "border",
  "accent",
  "accentForeground",
] as const satisfies readonly (keyof ThemeColorSet)[];

const APPEARANCES: readonly MobileShellAppearance[] = ["light", "dark"];
const CHROME_KEYS: readonly (keyof MobileShellChromeColors)[] = [
  "scrim",
  "shadow",
  "frame",
];
const COLOR_KEYS = new Set(Object.keys(THEME_CSS_VAR_MAP));
const GLYPH = /^[a-z0-9][a-z0-9-]*$/;
const LEGACY_ID = /^[a-z][a-z0-9_-]*$/;
const APP_ID = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const CSS_PROPERTY = /^--[a-z][a-z0-9-]*$/;
const BUILTIN_PREFIX = /^[a-z][a-z0-9-]*:$/;

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim() === value && value.length > 0;

function isToken(value: unknown): value is MobileShellThemeToken {
  return (
    typeof value === "string" &&
    (COLOR_KEYS.has(value) ||
      (CHROME_KEYS as readonly string[]).includes(value) ||
      value === "fontBody" ||
      value === "fontDisplay")
  );
}

/** Every problem with a registration; empty when it can be used. */
export function validateMobileProductRegistration(value: unknown): string[] {
  const issues: string[] = [];
  const issue = (path: string, message: string) =>
    issues.push(`${path}: ${message}`);
  if (!record(value)) return ["registration: must be an object"];
  if (value.schema !== MOBILE_PRODUCT_SCHEMA)
    issue("schema", `must be ${MOBILE_PRODUCT_SCHEMA}`);
  if (value.schemaVersion !== MOBILE_PRODUCT_SCHEMA_VERSION)
    issue("schemaVersion", `must be ${MOBILE_PRODUCT_SCHEMA_VERSION}`);
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1)
    issue("revision", "must be a positive integer");

  const identity = value.identity;
  if (!record(identity)) issue("identity", "must be an object");
  else {
    if (!text(identity.appName)) issue("identity.appName", "is required");
    if (typeof identity.appId !== "string" || !APP_ID.test(identity.appId))
      issue("identity.appId", "must be a reverse-domain application id");
    if (!text(identity.characterName))
      issue("identity.characterName", "is required");
  }

  const theme = value.theme;
  if (!record(theme)) issue("theme", "must be an object");
  else {
    for (const error of validateThemeDefinition(theme))
      issue(`theme.${error.field}`, error.message);
    if (!["light", "dark", "system"].includes(String(theme.defaultAppearance)))
      issue("theme.defaultAppearance", "must be light, dark or system");
    for (const appearance of APPEARANCES) {
      const colors = theme[appearance];
      const chrome = record(theme.chrome) ? theme.chrome[appearance] : null;
      for (const token of MOBILE_SHELL_REQUIRED_COLORS)
        if (!record(colors) || !text(colors[token]))
          issue(`theme.${appearance}.${token}`, "is required");
      for (const key of CHROME_KEYS)
        if (!record(chrome) || !text(chrome[key]))
          issue(`theme.chrome.${appearance}.${key}`, "is required");
    }
    if (theme.aliases !== undefined) {
      if (!record(theme.aliases)) issue("theme.aliases", "must be an object");
      else
        for (const [name, token] of Object.entries(theme.aliases)) {
          const reserved =
            Object.values(THEME_CSS_VAR_MAP).includes(name) ||
            name.startsWith("--mobile-shell-") ||
            name.startsWith("--font-") ||
            ["--txt", "--primary", "--primary-foreground", "--mono"].includes(
              name,
            );
          if (!CSS_PROPERTY.test(name) || reserved)
            issue(`theme.aliases.${name}`, "must be a product property name");
          if (!isToken(token))
            issue(`theme.aliases.${name}`, "must name a theme token");
        }
    }
  }

  const icons = value.icons;
  if (!record(icons)) issue("icons", "must be an object");
  else {
    if (!text(icons.baseUrl) || !icons.baseUrl.endsWith("/"))
      issue("icons.baseUrl", "must be a URL prefix ending in /");
    if (typeof icons.allApps !== "string" || !GLYPH.test(icons.allApps))
      issue("icons.allApps", "must be a glyph name");
    if (!record(icons.views)) issue("icons.views", "must be an object");
    else
      for (const [id, glyph] of Object.entries(icons.views)) {
        if (!isMobileShellViewId(id))
          issue(`icons.views.${id}`, "is not a canonical view id");
        if (typeof glyph !== "string" || !GLYPH.test(glyph))
          issue(`icons.views.${id}`, "must be a glyph name");
      }
  }

  if (value.backgrounds !== undefined) {
    const home = record(value.backgrounds) ? value.backgrounds.home : null;
    if (!record(value.backgrounds) || (home !== undefined && !record(home)))
      issue("backgrounds", "must map home to appearances");
    else if (record(home))
      for (const [appearance, background] of Object.entries(home))
        if (
          !APPEARANCES.includes(appearance as MobileShellAppearance) ||
          !text(background)
        )
          issue(`backgrounds.home.${appearance}`, "must be a CSS background");
  }

  const views = value.views;
  if (!record(views)) issue("views", "must be an object");
  else {
    const order = Array.isArray(views.order) ? views.order : null;
    if (!order?.length) issue("views.order", "must list the product's views");
    const ordered = new Set<string>();
    for (const id of order ?? []) {
      if (!isMobileShellViewId(id) || id === MOBILE_SHELL_HOME_VIEW_ID)
        issue("views.order", `${String(id)} is not an app view id`);
      else if (ordered.has(id)) issue("views.order", `${id} is listed twice`);
      ordered.add(String(id));
    }
    if (!record(views.legacyIds)) issue("views.legacyIds", "must be an object");
    else
      for (const [legacy, id] of Object.entries(views.legacyIds)) {
        if (!LEGACY_ID.test(legacy) || isMobileShellViewId(legacy))
          issue(`views.legacyIds.${legacy}`, "must be a non-canonical id");
        if (!isMobileShellViewId(id))
          issue(`views.legacyIds.${legacy}`, "must map to a canonical id");
      }
    if (views.serves !== undefined) {
      if (!record(views.serves)) issue("views.serves", "must be an object");
      else {
        const served = new Set<string>();
        for (const [owner, ids] of Object.entries(views.serves)) {
          if (!ordered.has(owner))
            issue(`views.serves.${owner}`, "must be an ordered view");
          for (const id of Array.isArray(ids) ? ids : [null]) {
            if (
              !isMobileShellViewId(id) ||
              id === MOBILE_SHELL_HOME_VIEW_ID ||
              ordered.has(id) ||
              served.has(id)
            )
              issue(`views.serves.${owner}`, `cannot serve ${String(id)}`);
            served.add(String(id));
          }
        }
      }
    }
  }

  const storage = value.storage;
  if (!record(storage)) issue("storage", "must be an object");
  else {
    const keys = [storage.launcherFavorites];
    if (!text(storage.launcherFavorites))
      issue("storage.launcherFavorites", "is required");
    if (
      typeof storage.launcherBuiltinPrefix !== "string" ||
      !BUILTIN_PREFIX.test(storage.launcherBuiltinPrefix)
    )
      issue("storage.launcherBuiltinPrefix", "must be a lowercase name and :");
    if (!record(storage.retained))
      issue("storage.retained", "must be an object");
    else
      for (const [name, key] of Object.entries(storage.retained)) {
        if (!text(key)) issue(`storage.retained.${name}`, "is required");
        keys.push(key);
      }
    const seen = new Set<unknown>();
    for (const key of keys) {
      if (seen.has(key)) issue("storage", `${String(key)} is named twice`);
      seen.add(key);
    }
  }
  return issues;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

/** Validates and freezes a registration; throws listing every problem. */
export function defineMobileProductRegistration<
  T extends MobileProductRegistration,
>(registration: T): T {
  const issues = validateMobileProductRegistration(registration);
  if (issues.length)
    throw new TypeError(
      `Invalid mobile product registration: ${issues.join("; ")}`,
    );
  return freeze(registration);
}

/** The owner's choice, or the product default; `system` follows the device. */
export function resolveMobileShellAppearance(
  registration: MobileProductRegistration,
  preference: unknown,
  prefersDark: boolean,
): MobileShellAppearance {
  const choice =
    preference === "light" || preference === "dark" || preference === "system"
      ? preference
      : registration.theme.defaultAppearance;
  if (choice === "system") return prefersDark ? "dark" : "light";
  return choice;
}

/**
 * CSS custom properties of one appearance: the canonical theme properties,
 * the shell chrome and Home background, and the product's declared aliases.
 */
export function mobileShellThemeVariables(
  registration: MobileProductRegistration,
  appearance: MobileShellAppearance,
): Record<string, string> {
  const { theme } = registration;
  const colors = theme[appearance];
  const chrome = theme.chrome[appearance];
  const variables = themeCssVariables(theme, appearance);
  variables["--mobile-shell-scrim"] = chrome.scrim;
  variables["--mobile-shell-shadow"] = chrome.shadow;
  variables["--mobile-shell-frame"] = chrome.frame;
  const home = registration.backgrounds?.home?.[appearance] ?? colors.bg;
  if (home) variables["--mobile-shell-home-background"] = home;
  for (const [name, token] of Object.entries(theme.aliases ?? {})) {
    const value =
      token === "fontBody"
        ? theme.fonts?.body
        : token === "fontDisplay"
          ? theme.fonts?.display
          : token in chrome
            ? chrome[token as keyof MobileShellChromeColors]
            : colors[token as keyof ThemeColorSet];
    if (value) variables[name] = value;
  }
  return variables;
}

/** Sets the theme on one element; the returned function removes it again. */
export function applyMobileShellTheme(
  element: {
    style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty">;
  },
  registration: MobileProductRegistration,
  appearance: MobileShellAppearance,
): () => void {
  const variables = mobileShellThemeVariables(registration, appearance);
  for (const [name, value] of Object.entries(variables))
    element.style.setProperty(name, value);
  return () => {
    for (const name of Object.keys(variables))
      element.style.removeProperty(name);
  };
}

/** URL of a glyph in the product icon set. */
export function mobileShellIconUrl(
  registration: MobileProductRegistration,
  glyph: string,
): string {
  return `${registration.icons.baseUrl}${glyph}.svg`;
}
