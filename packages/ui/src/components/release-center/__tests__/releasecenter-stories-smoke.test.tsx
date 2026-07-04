// @vitest-environment jsdom
/** jsdom smoke gate: renders every release-center/ Storybook story and asserts it mounts without throwing. */
import { smokeStoryModules } from "../../../../test/portable-stories";

const modules = import.meta.glob("../**/*.stories.tsx", { eager: true });
smokeStoryModules("releasecenter", modules, { minModules: 1 });
