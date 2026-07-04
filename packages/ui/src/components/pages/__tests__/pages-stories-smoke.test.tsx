// @vitest-environment jsdom
/**
 * Portable-stories smoke test for the pages surface. See test/portable-stories.tsx.
 * A few page stories need the full app runtime (live plugins / appRuns) that
 * jsdom composition can't supply; those are skip-listed and covered by the
 * browser story gate (needs-runtime) + live audit:app.
 */
import { smokeStoryModules } from "../../../../test/portable-stories";

const modules = import.meta.glob("../**/*.stories.tsx", { eager: true });

smokeStoryModules("pages", modules, {
  minModules: 1,
  skip: [],
});
