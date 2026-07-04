// @vitest-environment jsdom
/**
 * Portable-stories smoke test for the stream surface. Composes every stream
 * *.stories.tsx and renders it in jsdom. See test/portable-stories.tsx.
 */
import { smokeStoryModules } from "../../../../test/portable-stories";

const modules = import.meta.glob("../**/*.stories.tsx", { eager: true });
smokeStoryModules("streamcomp", modules, { minModules: 1 });
