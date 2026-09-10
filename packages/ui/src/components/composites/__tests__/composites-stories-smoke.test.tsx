/** Verifies composites stories smoke through the package's configured test harness. */
// @vitest-environment jsdom
/**
 * Portable-stories smoke test for the composites surface. Composes every
 * composites *.stories.tsx and renders it in jsdom. See test/portable-stories.tsx.
 */
import { smokeStoryModules } from "../../../../test/portable-stories";

const modules = import.meta.glob("../**/*.stories.tsx", { eager: true });

smokeStoryModules("composites", modules, {
  minModules: 1,
  // jsdom has no layout; keep mounting this story here while its unchanged
  // width/overflow and computed-style contract runs in the browser story gate.
  browserOnlyPlay: ["chat-bubble/FirstRun"],
});
