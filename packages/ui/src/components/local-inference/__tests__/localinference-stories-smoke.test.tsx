// @vitest-environment jsdom
/**
 * Portable-stories smoke test for the localinference surface. Composes every
 * localinference *.stories.tsx and renders it in jsdom. See test/portable-stories.tsx.
 */
import { smokeStoryModules } from "../../../../test/portable-stories";

const modules = import.meta.glob("../**/*.stories.tsx", { eager: true });

smokeStoryModules("localinference", modules, { minModules: 1 });
