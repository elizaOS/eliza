// @vitest-environment jsdom
import { smokeStoryModules } from "../../../test/portable-stories";
const modules = import.meta.glob("../**/*.stories.tsx", { eager: true });
smokeStoryModules("agentsurface", modules, { minModules: 1 });
