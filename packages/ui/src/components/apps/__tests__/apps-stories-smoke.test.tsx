/** Verifies apps stories smoke through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Smoke-renders every `apps/**` Storybook story in jsdom to catch import/render
 * crashes; the stories are the real modules, glob-loaded eagerly.
 */

import { smokeStoryModules } from "../../../../test/portable-stories";

const modules = import.meta.glob("../**/*.stories.tsx", { eager: true });
smokeStoryModules("apps", modules, { minModules: 1 });
