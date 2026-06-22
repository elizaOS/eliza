// @vitest-environment jsdom
import { smokeStoryModules } from "../../../../test/portable-stories";
const modules = import.meta.glob("../**/*.stories.tsx", { eager: true });
smokeStoryModules("workspace", modules, { minModules: 1 });
