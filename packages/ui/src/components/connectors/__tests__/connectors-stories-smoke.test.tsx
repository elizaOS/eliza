// @vitest-environment jsdom
/**
 * Portable-stories smoke test for the connectors surface. Composes every
 * connectors *.stories.tsx and renders it in jsdom. See test/portable-stories.tsx.
 */
import { smokeStoryModules } from "../../../../test/portable-stories";

const modules = import.meta.glob("../**/*.stories.tsx", { eager: true });

smokeStoryModules("connectors", modules, { minModules: 1 });
