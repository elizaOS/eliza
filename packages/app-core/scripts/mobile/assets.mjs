/** Owns mobile brand image generation using the shared build context and existing platform contracts. */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  ANDROID_CLOUD_SPLASH_MARK_RESOURCE,
  ANDROID_CLOUD_SPLASH_MARK_SIZE,
  applyAndroidCloudSplashTheme,
} from "./android/cloud-policy.mjs";
import { assertSharedTreeOnlyForEliza } from "./android/shared-tree.mjs";
import { run } from "./build-tools.mjs";
import { APP, androidDir, appDir, iosDir } from "./context.mjs";
import { firstExisting, resolveExecutable } from "./toolchain.mjs";

// Opaque app-icon background on iOS and the Android adaptive-icon background
// color. Resolved per-brand from app.config.ts (web.iconBackgroundColor) by
// readAppIdentity so each whitelabel ships its own brand color; defaults to the
// upstream elizaOS accent when the field is absent.
export const BRAND_ICON_BACKGROUND = APP.iconBackgroundColor;

export const ANDROID_LAUNCHER_ICON_SIZES = {
  "mipmap-mdpi": 48,
  "mipmap-hdpi": 72,
  "mipmap-xhdpi": 96,
  "mipmap-xxhdpi": 144,
  "mipmap-xxxhdpi": 192,
};

// Adaptive-icon foreground + monochrome layers are authored on the standard
// 108dp canvas (scaled per density). Both layers use the same square sizes.
export const ANDROID_ADAPTIVE_ICON_SIZES = {
  "mipmap-mdpi": 108,
  "mipmap-hdpi": 162,
  "mipmap-xhdpi": 216,
  "mipmap-xxhdpi": 324,
  "mipmap-xxxhdpi": 432,
};

export const ANDROID_SPLASH_SIZES = {
  drawable: [480, 320],
  "drawable-port-mdpi": [320, 480],
  "drawable-port-hdpi": [480, 720],
  "drawable-port-xhdpi": [640, 960],
  "drawable-port-xxhdpi": [960, 1440],
  "drawable-port-xxxhdpi": [1280, 1920],
  "drawable-land-mdpi": [480, 320],
  "drawable-land-hdpi": [720, 480],
  "drawable-land-xhdpi": [960, 640],
  "drawable-land-xxhdpi": [1440, 960],
  "drawable-land-xxxhdpi": [1920, 1280],
};

export async function loadImageToolForBrandAssets(platform) {
  try {
    return { kind: "sharp", sharp: (await import("sharp")).default };
  } catch (error) {
    const magick = resolveExecutable("magick");
    if (magick) {
      console.warn(
        `[mobile-build] sharp is unavailable for ${platform} brand assets; using ImageMagick fallback.`,
      );
      return { kind: "magick", magick };
    }
    const sips =
      process.platform === "darwin" ? resolveExecutable("sips") : null;
    if (sips) {
      console.warn(
        `[mobile-build] sharp is unavailable for ${platform} brand assets; using macOS sips fallback.`,
      );
      return { kind: "sips", sips };
    }
    throw new Error(
      `sharp is required to generate ${platform} brand assets for ${APP.appName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function writeCoverPng(
  tool,
  source,
  output,
  width,
  height,
  options = {},
) {
  if (tool.kind === "sharp") {
    let image = tool.sharp(source).resize(width, height, {
      fit: "cover",
      position: "center",
    });
    if (options.flattenBackground) {
      image = image.flatten({ background: options.flattenBackground });
    }
    await image.png().toFile(output);
    return;
  }

  if (tool.kind === "sips") {
    await run(tool.sips, [
      "--resampleHeightWidth",
      String(height),
      String(width),
      source,
      "--out",
      output,
    ]);
    return;
  }

  const args = [
    source,
    "-resize",
    `${width}x${height}^`,
    "-gravity",
    "center",
    "-extent",
    `${width}x${height}`,
  ];
  if (options.flattenBackground) {
    args.push(
      "-background",
      options.flattenBackground,
      "-alpha",
      "remove",
      "-alpha",
      "off",
    );
  }
  args.push(output);
  await run(tool.magick, args);
}

// Render the transparent icon mark centered in a square canvas, sized to the
// adaptive-icon safe zone (~66%). Used for both the adaptive foreground and
// the themed monochrome layer. `canvas` is the exact output pixel size.
export async function writeAndroidForegroundPng(tool, source, output, canvas) {
  const art = Math.round(canvas * 0.66);
  if (tool.kind === "sharp") {
    const mark = await tool
      .sharp(source)
      .resize(art, art, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
    await tool
      .sharp({
        create: {
          width: canvas,
          height: canvas,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
      .composite([{ input: mark, gravity: "center" }])
      .png()
      .toFile(output);
    return;
  }

  if (tool.kind === "sips") {
    await writeCoverPng(tool, source, output, canvas, canvas);
    return;
  }

  await run(tool.magick, [
    source,
    "-resize",
    `${art}x${art}`,
    "-background",
    "none",
    "-gravity",
    "center",
    "-extent",
    `${canvas}x${canvas}`,
    output,
  ]);
}

export function resolveBrandSources() {
  return {
    // The icon mark is a transparent-background face chosen to contrast with
    // BRAND_ICON_BACKGROUND, so iOS can flatten it onto that color and Android
    // can drop it into the adaptive foreground/monochrome safe zone. The web
    // favicons share the accent hue, which would vanish when flattened onto it,
    // so the dedicated brand/app-icon.png master (authored for contrast against
    // the brand color) is preferred.
    iconSource: firstExisting([
      path.join(appDir, "public", "brand", "app-icon.png"),
      path.join(appDir, "public", "brand", "logos", "logo_white_nobg.svg"),
      path.join(appDir, "public", "android-chrome-512x512.png"),
      path.join(appDir, "public", "apple-touch-icon.png"),
      path.join(appDir, "public", "favicon-256x256.png"),
    ]),
    launchSource: firstExisting([
      path.join(appDir, "public", "launch-bg.png"),
      path.join(appDir, "public", "launch-bg.jpg"),
    ]),
  };
}

export async function generateIosBrandAssets() {
  const assetDir = path.join(iosDir, "App", "Assets.xcassets");
  if (!fs.existsSync(assetDir)) return;

  const { iconSource, launchSource } = resolveBrandSources();
  if (!iconSource && !launchSource) return;

  const imageTool = await loadImageToolForBrandAssets("iOS");

  if (iconSource) {
    const iconSetDir = path.join(assetDir, "AppIcon.appiconset");
    const contentsPath = path.join(iconSetDir, "Contents.json");
    if (fs.existsSync(contentsPath)) {
      const contents = JSON.parse(fs.readFileSync(contentsPath, "utf8"));
      for (const image of contents.images ?? []) {
        if (!image.filename || !image.size || !image.scale) continue;
        const [width] = String(image.size).split("x");
        const scale = Number.parseFloat(String(image.scale));
        const pixels = Math.round(Number.parseFloat(width) * scale);
        if (!Number.isFinite(pixels) || pixels <= 0) continue;
        await writeCoverPng(
          imageTool,
          iconSource,
          path.join(iconSetDir, image.filename),
          pixels,
          pixels,
          { flattenBackground: BRAND_ICON_BACKGROUND },
        );
      }
    }
  }

  if (launchSource) {
    const splashSetDir = path.join(assetDir, "Splash.imageset");
    const contentsPath = path.join(splashSetDir, "Contents.json");
    if (fs.existsSync(contentsPath)) {
      const contents = JSON.parse(fs.readFileSync(contentsPath, "utf8"));
      for (const image of contents.images ?? []) {
        if (!image.filename) continue;
        await writeCoverPng(
          imageTool,
          launchSource,
          path.join(splashSetDir, image.filename),
          2732,
          2732,
        );
      }
    }
  }

  console.log(`[mobile-build] Generated iOS brand assets for ${APP.appName}.`);
}

export async function generateAndroidBrandAssets({ cloudBuild = false } = {}) {
  assertSharedTreeOnlyForEliza("write brand icons");
  const resDir = path.join(androidDir, "app", "src", "main", "res");
  if (!fs.existsSync(resDir)) return;

  const { iconSource, launchSource } = resolveBrandSources();
  if (!iconSource && !launchSource) return;

  const imageTool = await loadImageToolForBrandAssets("Android");

  const stylesPath = path.join(resDir, "values", "styles.xml");
  if (!fs.existsSync(stylesPath)) {
    throw new Error("[mobile-build] Android styles.xml is missing");
  }
  fs.writeFileSync(
    stylesPath,
    applyAndroidCloudSplashTheme(fs.readFileSync(stylesPath, "utf8"), {
      cloudBuild,
    }),
    "utf8",
  );

  const cloudSplashMarkPath = path.join(
    resDir,
    "drawable-nodpi",
    `${ANDROID_CLOUD_SPLASH_MARK_RESOURCE}.png`,
  );
  if (!cloudBuild && fs.existsSync(cloudSplashMarkPath)) {
    fs.rmSync(cloudSplashMarkPath);
  }

  if (cloudBuild) {
    const cloudSplashSource = path.join(
      appDir,
      "public",
      "brand",
      "logos",
      "logo_white_nobg.svg",
    );
    const source = fs.readFileSync(cloudSplashSource, "utf8");
    if (
      !source.includes('fill="none"') ||
      !source.includes('fill="white"') ||
      /#FF5800|<rect[^>]+fill=["']#FF5800["']/i.test(source)
    ) {
      throw new Error(
        "[mobile-build] Android Cloud splash mark must be a transparent white face without a background rectangle",
      );
    }
    fs.mkdirSync(path.dirname(cloudSplashMarkPath), { recursive: true });
    await writeAndroidForegroundPng(
      imageTool,
      cloudSplashSource,
      cloudSplashMarkPath,
      ANDROID_CLOUD_SPLASH_MARK_SIZE,
    );
  }

  if (iconSource) {
    for (const [dir, size] of Object.entries(ANDROID_LAUNCHER_ICON_SIZES)) {
      const out = path.join(resDir, dir);
      fs.mkdirSync(out, { recursive: true });
      // Legacy (pre-adaptive) launcher icons are opaque squares, so flatten
      // the transparent mark onto the brand background.
      await writeCoverPng(
        imageTool,
        iconSource,
        path.join(out, "ic_launcher.png"),
        size,
        size,
        { flattenBackground: BRAND_ICON_BACKGROUND },
      );
      await writeCoverPng(
        imageTool,
        iconSource,
        path.join(out, "ic_launcher_round.png"),
        size,
        size,
        { flattenBackground: BRAND_ICON_BACKGROUND },
      );
      // Adaptive foreground + themed monochrome both sit on the system
      // background (the brand color below), so they stay transparent.
      const adaptiveCanvas = ANDROID_ADAPTIVE_ICON_SIZES[dir] ?? size;
      await writeAndroidForegroundPng(
        imageTool,
        iconSource,
        path.join(out, "ic_launcher_foreground.png"),
        adaptiveCanvas,
      );
      await writeAndroidForegroundPng(
        imageTool,
        iconSource,
        path.join(out, "ic_launcher_monochrome.png"),
        adaptiveCanvas,
      );
    }
    // Adaptive-icon background color must match the brand accent. This is a
    // static resource Capacitor never regenerates, so write it here to keep
    // it from drifting back to a stale value.
    const valuesDir = path.join(resDir, "values");
    fs.mkdirSync(valuesDir, { recursive: true });
    fs.writeFileSync(
      path.join(valuesDir, "ic_launcher_background.xml"),
      `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BRAND_ICON_BACKGROUND}</color>\n</resources>\n`,
      "utf8",
    );
  }

  if (launchSource) {
    for (const [dir, [width, height]] of Object.entries(ANDROID_SPLASH_SIZES)) {
      const out = path.join(resDir, dir);
      fs.mkdirSync(out, { recursive: true });
      await writeCoverPng(
        imageTool,
        launchSource,
        path.join(out, "splash.png"),
        width,
        height,
      );
    }
  }

  console.log(
    `[mobile-build] Generated Android brand assets for ${APP.appName}.`,
  );
}
