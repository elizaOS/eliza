/** Exercises verify android native plugins behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no types emitted; the shape is asserted below.
import { verifyAndroidNativePlugins } from "./verify-android-native-plugins.mjs";

/**
 * Gate for #9967: the generated-but-git-tracked `capacitor.settings.gradle` must
 * not silently drift from the declared `@elizaos/capacitor-*` app deps. Every
 * declared plugin that ships an Android module has to be in the compiled gradle
 * project list, or the launcher APK ships without it and no other test notices.
 */
describe("android native-plugin wiring (#9967)", () => {
  const result = verifyAndroidNativePlugins();

  it("compiles every declared, Android-capable native plugin into the gradle project list", () => {
    expect(
      result.missing,
      result.missing.length > 0
        ? `Missing from capacitor.settings.gradle — run \`npx cap sync android\` and commit: ${result.missing
            .map((p: { name: string }) => p.name)
            .join(", ")}`
        : "",
    ).toEqual([]);
  });

  it("has at least the known Android native-plugin floor wired (catches a wholesale-empty regression)", () => {
    // 17 declared Android plugins are wired today; assert we never silently drop
    // below a sane floor (e.g. a regenerated-empty settings file).
    expect(result.required.length).toBeGreaterThanOrEqual(15);
  });
});
