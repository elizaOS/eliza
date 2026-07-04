// @vitest-environment jsdom
/**
 * Portable-stories smoke test for the tool-events surface. Composes every
 * tool-events *.stories.tsx and renders it in jsdom. See test/portable-stories.tsx.
 */
import { smokeStoryModules } from "../../../../test/portable-stories";

const modules = import.meta.glob("../**/*.stories.tsx", { eager: true });
smokeStoryModules("toolevents", modules, { minModules: 1 });
