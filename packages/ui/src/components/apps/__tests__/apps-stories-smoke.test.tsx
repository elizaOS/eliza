// @vitest-environment jsdom
import { smokeStoryModules } from "../../../../test/portable-stories";

const modules = import.meta.glob("../**/*.stories.tsx", { eager: true });
smokeStoryModules("apps", modules, { minModules: 1 });
