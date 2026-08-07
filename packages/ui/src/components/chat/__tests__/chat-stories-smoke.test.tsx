/** Verifies chat stories smoke through the package's configured test harness. */
// @vitest-environment jsdom
import { smokeStoryModules } from "../../../../test/portable-stories";

const modules = import.meta.glob("../**/*.stories.tsx", { eager: true });
smokeStoryModules("chat", modules, { minModules: 1 });
