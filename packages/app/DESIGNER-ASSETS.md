# Eliza Native Asset Regeneration Spec

All native PNG assets in this directory need to be regenerated for the new **Eliza orange** brand. This file is the single source of truth for the designer (or automated pipeline) — every PNG listed below must end up at the exact path, pixel dimensions, and color shown.

**Brand colors** (canonical, from `packages/app/android/app/src/main/res/values/colors.xml`):
- Orange (primary / splash): `#FF5800`
- Blue: `#0B35F1`
- Black: `#000000`
- White: `#FFFFFF`
- Gray: `#D1D0D4`

**Canonical logos** live in `packages/shared-brand/assets/logos/`. The ones referenced here:
- `logo_white_nobg.svg` — white mark on transparent (use on orange bg)
- `logo_white_orangebg.svg` — white mark already composited onto orange (single-layer alternative)
- `eliza_logotext.svg` — white wordmark (used in OG embeds)

**Font:** the wordmark glyphs in `eliza_logotext.svg` are already outlined — no system font needed.

**Format defaults:** PNG, sRGB, 8-bit/channel. Use alpha (RGBA) **only** where noted (adaptive-icon foregrounds and favicons). Splash and app-icon PNGs are flat RGB (no alpha) — iOS rejects alpha in marketing icons.

---

## ImageMagick / rsvg-convert command patterns

The designer can script all assets with one of two toolchains. Both are deterministic and reproducible.

**A. Square solid-bg icon (centered logo, no padding):**
```bash
# $SIZE = output edge px, $FG_PCT = foreground % of canvas (e.g. 60)
rsvg-convert -w $((SIZE * FG_PCT / 100)) -h $((SIZE * FG_PCT / 100)) \
  packages/shared-brand/assets/logos/logo_white_nobg.svg -o /tmp/fg.png
magick -size ${SIZE}x${SIZE} xc:'#FF5800' /tmp/fg.png \
  -gravity center -composite -strip PNG24:OUT.png
```

**B. Rectangular splash (portrait or landscape):**
```bash
# $W $H = output px, foreground = 28% of min(W,H)
FG=$(( (W < H ? W : H) * 28 / 100 ))
rsvg-convert -w $FG -h $FG packages/shared-brand/assets/logos/logo_white_nobg.svg -o /tmp/fg.png
magick -size ${W}x${H} xc:'#FF5800' /tmp/fg.png \
  -gravity center -composite -strip PNG24:OUT.png
```

**C. Adaptive-icon foreground (RGBA, 66% mark, transparent bg):**
```bash
FG=$(( SIZE * 66 / 100 ))
rsvg-convert -w $FG -h $FG packages/shared-brand/assets/logos/logo_white_nobg.svg -o /tmp/fg.png
magick -size ${SIZE}x${SIZE} xc:none /tmp/fg.png \
  -gravity center -composite PNG32:OUT.png
```

**D. Round-masked launcher (`ic_launcher_round.png`):**
```bash
magick OUT_square.png \
  \( +clone -alpha extract -fill white -draw "circle $((SIZE/2)),$((SIZE/2)) $((SIZE/2)),0" \) \
  -compose CopyOpacity -composite PNG32:OUT_round.png
```

**E. OG embed (1200×630 wordmark):**
```bash
H=189   # 30% of 630
rsvg-convert -h $H packages/shared-brand/assets/logos/eliza_logotext.svg -o /tmp/wm.png
magick -size 1200x630 xc:'#FF5800' /tmp/wm.png -gravity center -composite -strip PNG24:OUT.png
```

---

## iOS — Splash imageset

Path prefix: `packages/app/ios/App/App/Assets.xcassets/Splash.imageset/`

The existing `Contents.json` declares three **universal** images all at the same 2732×2732 source dimension across @1x / @2x / @3x (filenames do **not** carry `~ipad` suffix). All three files are byte-identical content; iOS just picks per scale. Designer should produce one master and copy it 3×, or generate each independently.

- `splash-2732x2732.png` — 2732×2732 — bg `#FF5800` — fg `logo_white_nobg.svg`, white, centered, **28% of frame height** (765 px tall) — square — PNG24 (no alpha) — Contents.json scale `3x`
- `splash-2732x2732-1.png` — 2732×2732 — same as above — Contents.json scale `2x`
- `splash-2732x2732-2.png` — 2732×2732 — same as above — Contents.json scale `1x`

---

## iOS — AppIcon imageset

Path prefix: `packages/app/ios/App/App/Assets.xcassets/AppIcon.appiconset/`

Background `#FF5800`. Foreground `logo_white_nobg.svg`, white, centered, **60% of frame edge**. No padding / no rounded corners — iOS applies the squircle mask. **PNG24, no alpha.** Source aspect: square.

| Filename | px |
|---|---|
| `AppIcon-iphone-20x20@2x.png` | 40×40 |
| `AppIcon-iphone-20x20@3x.png` | 60×60 |
| `AppIcon-iphone-29x29@2x.png` | 58×58 |
| `AppIcon-iphone-29x29@3x.png` | 87×87 |
| `AppIcon-iphone-40x40@2x.png` | 80×80 |
| `AppIcon-iphone-40x40@3x.png` | 120×120 |
| `AppIcon-iphone-60x60@2x.png` | 120×120 |
| `AppIcon-iphone-60x60@3x.png` | 180×180 |
| `AppIcon-ipad-20x20@1x.png` | 20×20 |
| `AppIcon-ipad-20x20@2x.png` | 40×40 |
| `AppIcon-ipad-29x29@1x.png` | 29×29 |
| `AppIcon-ipad-29x29@2x.png` | 58×58 |
| `AppIcon-ipad-40x40@1x.png` | 40×40 |
| `AppIcon-ipad-40x40@2x.png` | 80×80 |
| `AppIcon-ipad-76x76@1x.png` | 76×76 |
| `AppIcon-ipad-76x76@2x.png` | 152×152 |
| `AppIcon-ipad-83_5x83_5@2x.png` | 167×167 |
| `AppIcon-ios-marketing-1024.png` | 1024×1024 (App Store; must be flat RGB, no alpha, no transparency) |

Total: **18 PNGs.**

---

## Android — Splash drawables

Path prefix: `packages/app/android/app/src/main/res/`

Background `#FF5800`. Foreground `logo_white_nobg.svg`, white, centered, **28% of the smaller dimension** (min(W,H)). PNG24 (no alpha). Aspect varies per orientation. Densities follow Android `ldpi/mdpi/hdpi/xhdpi/xxhdpi/xxxhdpi` notation — note this app uses **mdpi through xxxhdpi** (no ldpi), plus a fallback `drawable/splash.png` at mdpi-equivalent.

| Filename | px | orientation |
|---|---|---|
| `drawable/splash.png` | 480×320 | landscape fallback |
| `drawable-port-mdpi/splash.png` | 320×480 | portrait |
| `drawable-port-hdpi/splash.png` | 480×800 | portrait |
| `drawable-port-xhdpi/splash.png` | 720×1280 | portrait |
| `drawable-port-xxhdpi/splash.png` | 960×1600 | portrait |
| `drawable-port-xxxhdpi/splash.png` | 1280×1920 | portrait |
| `drawable-land-mdpi/splash.png` | 480×320 | landscape |
| `drawable-land-hdpi/splash.png` | 800×480 | landscape |
| `drawable-land-xhdpi/splash.png` | 1280×720 | landscape |
| `drawable-land-xxhdpi/splash.png` | 1600×960 | landscape |
| `drawable-land-xxxhdpi/splash.png` | 1920×1280 | landscape |

Total: **11 PNGs.**

---

## Android — Mipmap launcher icons

Path prefix: `packages/app/android/app/src/main/res/`

Three variants per density across 5 densities (mdpi → xxxhdpi). Note: `mipmap-anydpi-v26/ic_launcher.xml` already composes the adaptive icon from `@color/ic_launcher_background` (which is `#FF5800`, set in `values/ic_launcher_background.xml`) + `@mipmap/ic_launcher_foreground`. So legacy PNGs are still required for API < 26.

**`ic_launcher.png`** — legacy square launcher. Background `#FF5800`. Foreground `logo_white_nobg.svg`, white, centered, **60% of canvas edge**. PNG32 (RGBA — keeps consistent with existing files, alpha can be fully opaque). Square.

| Filename | px |
|---|---|
| `mipmap-mdpi/ic_launcher.png` | 48×48 |
| `mipmap-hdpi/ic_launcher.png` | 72×72 |
| `mipmap-xhdpi/ic_launcher.png` | 96×96 |
| `mipmap-xxhdpi/ic_launcher.png` | 144×144 |
| `mipmap-xxxhdpi/ic_launcher.png` | 192×192 |

**`ic_launcher_round.png`** — same content as `ic_launcher.png`, then masked by a centered circle of radius = edge/2. Background outside the circle is **fully transparent** (PNG32, RGBA).

| Filename | px |
|---|---|
| `mipmap-mdpi/ic_launcher_round.png` | 48×48 |
| `mipmap-hdpi/ic_launcher_round.png` | 72×72 |
| `mipmap-xhdpi/ic_launcher_round.png` | 96×96 |
| `mipmap-xxhdpi/ic_launcher_round.png` | 144×144 |
| `mipmap-xxxhdpi/ic_launcher_round.png` | 192×192 |

**`ic_launcher_foreground.png`** — adaptive-icon foreground layer. **Transparent background (PNG32, RGBA)**. Foreground `logo_white_nobg.svg`, white, centered, **66% of canvas edge** (Android reserves the outer ~33% for safe-zone padding / parallax). Canvas is 108dp logical, sized per density. Square.

| Filename | px |
|---|---|
| `mipmap-mdpi/ic_launcher_foreground.png` | 108×108 |
| `mipmap-hdpi/ic_launcher_foreground.png` | 162×162 |
| `mipmap-xhdpi/ic_launcher_foreground.png` | 216×216 |
| `mipmap-xxhdpi/ic_launcher_foreground.png` | 324×324 |
| `mipmap-xxxhdpi/ic_launcher_foreground.png` | 432×432 |

Total: **15 PNGs.**

---

## Web / OG

- `packages/app/public/og-image.png` — **1200×630** — bg `#FF5800` — fg `eliza_logotext.svg` (white wordmark), centered, **30% of height** (~189 px tall) — landscape — PNG24, no alpha. *(Current file is 1000×1000 — needs full regen to 1200×630.)*

**Per-surface OG embeds** in `packages/shared-brand/assets/ogembeds/`. These already exist at 1200×630 RGB and are paired with same-named SVGs that should match the orange brand. Regenerate by exporting the SVG at 1200×630 (use `rsvg-convert -w 1200 -h 630 SRC.svg -o OUT.png`, then `magick OUT.png -strip PNG24:OUT.png` to drop alpha). Content per file follows its corresponding SVG.

| Filename | px | source SVG |
|---|---|---|
| `eliza_ogembed.png` | 1200×630 | `eliza_ogembed.svg` |
| `elizaos_ogembed.png` | 1200×630 | `elizaos_ogembed.svg` |
| `elizacloud_ogembed.png` | 1200×630 | `elizacloud_ogembed.svg` |

Total: **4 PNGs** (`og-image.png` + 3 ogembeds).

---

## Favicons

Path prefix: `packages/shared-brand/assets/favicons/`

These PNGs already exist. **They must be visually inspected and confirmed against the new orange brand.** If any still use the legacy blue (`#0B35F1`) or any non-`#FF5800` background, regenerate. The canonical `favicon.svg` in the same directory is the source of truth — re-export it at each size.

Spec for regen (if needed): bg `#FF5800`, fg `logo_white_nobg.svg` at **66% of canvas edge**, centered, square, PNG32 (RGBA — favicons may have transparent corners on round Android variants).

| Filename | px | notes |
|---|---|---|
| `favicon-16x16.png` | 16×16 | RGB ok |
| `favicon-32x32.png` | 32×32 | RGBA |
| `apple-touch-icon.png` | 180×180 | RGBA, square (iOS masks on home screen) |
| `android-chrome-192x192.png` | 192×192 | RGBA |
| `android-chrome-512x512.png` | 512×512 | RGBA |
| `favicon.ico` | multi-res 16/32/48 | rebuild from the 16 and 32 PNGs (`magick favicon-16x16.png favicon-32x32.png favicon.ico`) |

Total: **5 PNGs + 1 ICO** (regen only if not already orange).

---

## Asset count summary

| Category | Count |
|---|---|
| iOS Splash | 3 |
| iOS AppIcon | 18 |
| Android Splash | 11 |
| Android Launcher (mipmap) | 15 |
| Web / OG | 4 |
| Favicons (conditional) | 5 PNG + 1 ICO |
| **Total PNGs to regen (worst case)** | **56** |
| **Total PNGs (excluding favicons if already orange)** | **51** |

---

## Verification checklist

After regeneration:
1. `file packages/app/ios/App/App/Assets.xcassets/AppIcon.appiconset/*.png` — every line should report `PNG image data, WxH, 8-bit/color RGB` (no `RGBA`) for AppIcon and Splash.
2. `file packages/app/android/app/src/main/res/mipmap-*/ic_launcher_foreground.png` — must report `RGBA`.
3. Marketing icon `AppIcon-ios-marketing-1024.png` must be exactly 1024×1024, RGB, **no alpha channel** — App Store Connect rejects alpha.
4. Open `packages/app/ios/App/App/Assets.xcassets/Splash.imageset/Contents.json` and `AppIcon.appiconset/Contents.json` and confirm every declared filename exists on disk.
5. Build iOS (`xcodebuild ...`) and Android (`./gradlew assembleDebug`) — both should consume the new assets without warning.
