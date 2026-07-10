/**
 * Source-scanning gate banning backdrop-filter/backdrop-blur app-wide — the
 * glassmorphic blur is the biggest GPU/battery cost (#9141). Reads the src tree,
 * no runtime.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #9141 (battery): backdrop-filter — the glassmorphic blur (backdrop-blur /
// backdrop-saturate / backdrop-brightness) — forces the GPU to continuously
// re-sample the backdrop, EVEN on static elements, and re-rasterize per frame on
// anything that moves (the dragged chat sheet, scrolling surfaces). It is the
// single biggest GPU/battery cost in the UI and was removed app-wide. This gate
// fails the build if any backdrop-filter creeps back, so the battery win can't
// silently regress. (To intentionally reintroduce one, you'd remove it here with
// a justification — but the product decision is no blur.)

const SOURCE_ROOTS = [
  {
    label: "packages/ui/src",
    root: import.meta.dirname,
  },
  {
    label: "packages/app/src",
    root: join(import.meta.dirname, "../../app/src"),
  },
] as const;

// Match the Tailwind blur utilities, their arbitrary forms, the `supports-`
// modifier, and the raw CSS / inline-style property spellings.
const BACKDROP_FILTER =
  /backdrop-blur|backdrop-saturate|backdrop-brightness|backdrop-contrast|backdrop-filter|backdropFilter|WebkitBackdropFilter|supports-\[backdrop-filter\]/;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    // __e2e__ holds generated/bundled HTML+CSS fixtures (vendored blur in the
    // framer-motion/tailwind bundle), not authored UI — not subject to the gate.
    if (name === "node_modules" || name === "dist" || name === "__e2e__") {
      continue;
    }
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if (
      /\.(tsx?|css)$/.test(name) &&
      !name.includes(".test.") &&
      !name.includes(".spec.")
    ) {
      out.push(full);
    }
  }
  return out;
}

// The liquid-glass system reintroduced backdrop blur ON A NAMED SET OF GLASS
// SURFACES by explicit product direction (the frosted chat sheet + notification
// shade + home glass — #10698 revisited: the frosted look is worth the battery
// cost on these floating surfaces, whose blur is inactive at rest and gated to
// the open/animating state). #9141's default stands everywhere else: this gate
// still fails the build on any NEW backdrop-filter outside this list, so an
// accidental blur creeping onto an unrelated surface is still caught. To extend
// the list, add the surface here WITH a reason — do not widen the regex.
const ALLOWED_BLUR = new Set<string>([
  "packages/ui/src/components/shell/liquid-glass.tsx",
  "packages/ui/src/components/shell/liquid-glass.stories.tsx",
  "packages/ui/src/components/shell/home-glass.ts",
  "packages/ui/src/components/shell/wallpaper-idiom.ts",
  "packages/ui/src/components/shell/ContinuousChatOverlay.tsx",
  "packages/ui/src/components/shell/NotificationsHomeCenter.tsx",
  "packages/ui/src/components/shell/NotificationBanners.tsx",
  "packages/ui/src/components/shell/BuildBadge.tsx",
  "packages/ui/src/components/chat/widgets/home-widget-card.tsx",
  // The unified liquid-glass system (GlassSurface + its tokens/native bridge).
  // The blur is the CSS-tier material for stable chrome (sheets at rest, pills,
  // menus, headers) and is switched OFF entirely on the native tier
  // (`data-glass-tier="native"` → `backdrop-filter: none`, a real
  // UIGlassEffect replaces it). Same product direction as the shell
  // liquid-glass surfaces above; this generalizes them into one primitive.
  "packages/ui/src/glass/GlassSurface.tsx",
  "packages/ui/src/glass/tokens.ts",
  "packages/ui/src/glass/useNativeGlass.ts",
  // The theme-aware wallpaper readability scrim (`app-background-scrim`): a
  // frosted veil (bg/75 + blur) applied ONLY on text-dense shared-background
  // views (`wallpaperScrimActive`), so agent copy stays legible over any
  // wallpaper. Immersive surfaces (chat, /background, launcher roots) render
  // unscrimmed, so the blur is not on the hottest scroll paths. Explicit
  // product direction for legibility (fix: theme-aware frosted wallpaper scrim).
  "packages/ui/src/App.tsx",
  // Comment-only reference (documents the notification-stack blur it mirrors);
  // no runtime backdrop-filter of its own.
  "packages/ui/src/hooks/useHorizontalPager.ts",
]);

describe("no backdrop-blur gate (#9141, battery)", () => {
  it("no backdrop-filter / backdrop-blur survives outside the allow-listed glass surfaces", () => {
    const offenders: string[] = [];
    for (const { label, root } of SOURCE_ROOTS) {
      if (!existsSync(root)) continue;
      for (const file of collectSourceFiles(root)) {
        if (BACKDROP_FILTER.test(readFileSync(file, "utf8"))) {
          const rel = `${label}/${file.slice(root.length + 1).replace(/\\/g, "/")}`;
          if (!ALLOWED_BLUR.has(rel)) offenders.push(rel);
        }
      }
    }
    expect(
      offenders,
      `backdrop-filter must stay removed for battery outside the allow-listed glass surfaces; found in: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it("every allow-listed blur surface still exists and still uses backdrop-filter (no stale entries)", () => {
    for (const rel of ALLOWED_BLUR) {
      const abs = rel.replace(
        /^packages\/ui\/src\//,
        `${import.meta.dirname}/`,
      );
      expect(existsSync(abs), `${rel} is allow-listed but missing`).toBe(true);
      expect(
        BACKDROP_FILTER.test(readFileSync(abs, "utf8")),
        `${rel} is allow-listed but no longer uses backdrop-filter — remove it`,
      ).toBe(true);
    }
  });
});
