/**
 * Loads a private white-label brand (app name, icon, splash and boot animation)
 * from a directory outside the repository. Package identity and signing are not
 * brandable here: an Android white-label build keeps the canonical app ID and
 * keystore configuration so updates, role grants and pairing stay compatible.
 * Validation is fail-closed; a configured but invalid brand stops the build.
 */
import fs from "node:fs";
import path from "node:path";

export const WHITELABEL_DIR_ENV = "ELIZA_WHITELABEL_DIR";
export const WHITELABEL_MANIFEST = "brand.json";

export interface WhitelabelBrand {
  dir: string;
  appName: string;
  iconBackgroundColor?: string;
  /** Transparent launcher mark (PNG or SVG). */
  icon: string;
  /** Full-bleed launch image (PNG or JPEG); replaces the upstream splash. */
  splash: string;
  /** Transparent splash mark used by the Android Cloud splash theme. */
  splashMark?: string;
  bootanimation?: {
    /** Transparent logo rendered onto the boot field (PNG or SVG). */
    logo: string;
    background: string;
  };
}

const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "appName",
  "iconBackgroundColor",
  "icon",
  "splash",
  "splashMark",
  "bootanimation",
]);
const BOOTANIMATION_KEYS = new Set(["logo", "background"]);
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const IMAGE_EXTENSIONS = {
  icon: [".png", ".svg"],
  splash: [".png", ".jpg", ".jpeg"],
  splashMark: [".png", ".svg"],
  logo: [".png", ".svg"],
} as const;

function fail(message: string): never {
  throw new Error(`[whitelabel] ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      // Package ID, URL scheme and signing inputs are deliberately unknown keys.
      fail(`${where} has unsupported field "${key}"`);
    }
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function resolveAsset(
  dir: string,
  value: unknown,
  field: string,
  extensions: readonly string[],
): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${field} must be a relative file path`);
  }
  if (path.isAbsolute(value)) fail(`${field} must be relative to the brand`);
  const resolved = path.resolve(dir, value);
  if (!isInside(dir, resolved) || resolved === dir) {
    fail(`${field} must stay inside the brand directory`);
  }
  if (!extensions.includes(path.extname(resolved).toLowerCase())) {
    fail(`${field} must be one of ${extensions.join(", ")}`);
  }
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    fail(`${field} must be an existing regular file`);
  }
  return resolved;
}

function color(value: unknown, field: string): string {
  if (typeof value !== "string" || !HEX_COLOR.test(value)) {
    fail(`${field} must be a #RRGGBB color`);
  }
  return value;
}

/**
 * Parses `<dir>/brand.json`. `repoRoot` is required so private brand assets can
 * never be sourced from, and therefore committed into, the public checkout.
 */
export function loadWhitelabelBrandFromDir(
  directory: string,
  repoRoot: string,
): WhitelabelBrand {
  if (!path.isAbsolute(directory))
    fail(`${WHITELABEL_DIR_ENV} must be absolute`);
  const dir = fs.realpathSync(directory);
  if (isInside(fs.realpathSync(repoRoot), dir)) {
    fail(
      `${WHITELABEL_DIR_ENV} must point outside the repository; private brand assets stay out of Git`,
    );
  }
  const manifestPath = path.join(dir, WHITELABEL_MANIFEST);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (cause) {
    throw new Error(`[whitelabel] cannot read ${manifestPath}`, { cause });
  }
  if (!isRecord(raw)) fail(`${WHITELABEL_MANIFEST} must be a JSON object`);
  assertOnlyKeys(raw, TOP_LEVEL_KEYS, WHITELABEL_MANIFEST);
  if (raw.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (
    typeof raw.appName !== "string" ||
    raw.appName.trim() !== raw.appName ||
    raw.appName.length === 0 ||
    raw.appName.length > 30 ||
    /[<>&"'\\]/.test(raw.appName)
  ) {
    fail("appName must be 1-30 characters without XML or quote characters");
  }
  const brand: WhitelabelBrand = {
    dir,
    appName: raw.appName,
    icon: resolveAsset(dir, raw.icon, "icon", IMAGE_EXTENSIONS.icon),
    splash: resolveAsset(dir, raw.splash, "splash", IMAGE_EXTENSIONS.splash),
  };
  if (raw.iconBackgroundColor !== undefined) {
    brand.iconBackgroundColor = color(
      raw.iconBackgroundColor,
      "iconBackgroundColor",
    );
  }
  if (raw.splashMark !== undefined) {
    brand.splashMark = resolveAsset(
      dir,
      raw.splashMark,
      "splashMark",
      IMAGE_EXTENSIONS.splashMark,
    );
  }
  if (raw.bootanimation !== undefined) {
    if (!isRecord(raw.bootanimation)) fail("bootanimation must be an object");
    assertOnlyKeys(raw.bootanimation, BOOTANIMATION_KEYS, "bootanimation");
    brand.bootanimation = {
      logo: resolveAsset(
        dir,
        raw.bootanimation.logo,
        "bootanimation.logo",
        IMAGE_EXTENSIONS.logo,
      ),
      background: color(
        raw.bootanimation.background,
        "bootanimation.background",
      ),
    };
  }
  return brand;
}

/** Returns null when no white-label directory is configured. */
export function loadWhitelabelBrand(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): WhitelabelBrand | null {
  const directory = env[WHITELABEL_DIR_ENV]?.trim();
  return directory ? loadWhitelabelBrandFromDir(directory, repoRoot) : null;
}
