// @vitest-environment jsdom

/** Smoke-renders every backgrounds Storybook story under jsdom to catch a story that throws on mount. */
import { smokeStoryModules } from "../../../test/portable-stories";

const modules = import.meta.glob("../**/*.stories.tsx", { eager: true });
smokeStoryModules("backgrounds", modules, { minModules: 1 });
