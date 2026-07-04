// @vitest-environment jsdom
/** jsdom smoke gate: renders every shared/ Storybook story and asserts it mounts without throwing. */
import { smokeStoryModules } from "../../../../test/portable-stories";

const modules = import.meta.glob("../**/*.stories.tsx", { eager: true });
smokeStoryModules("shared", modules, { minModules: 1 });
