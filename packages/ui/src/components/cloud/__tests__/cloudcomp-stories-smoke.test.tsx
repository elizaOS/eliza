// @vitest-environment jsdom
/**
 * Portable-stories smoke test for the cloud surface. Composes every cloud
 * *.stories.tsx and renders it in jsdom. See test/portable-stories.tsx.
 */
import { smokeStoryModules } from "../../../../test/portable-stories";

const modules = import.meta.glob("../**/*.stories.tsx", { eager: true });
smokeStoryModules("cloudcomp", modules, { minModules: 1 });
